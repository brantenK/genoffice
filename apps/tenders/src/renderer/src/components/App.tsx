// Root shell: fixed left sidebar (nav + company switcher) + main content area.
import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
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
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import type { AppPage } from '../../shared/types'
import { createSampleWorkspaceRecord, isSampleWorkspace } from '../mock/sample-workspace'
import { useTendersStore } from '../store'
import { CompanyFormDialog } from './CompanyFormDialog'
import { FirstUsePage } from './FirstUsePage'
import { GuidedTour } from './GuidedTour'
import { LimitationsNotice } from './LimitationsNotice'
import { OnboardingModal } from './OnboardingModal'
import { SaveStatus } from './SaveStatus'
import { Button, Spinner } from './ui'
import { CustomersPage } from './pages/CustomersPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { OverviewPage } from './pages/OverviewPage'
import { ProfilePage } from './pages/ProfilePage'
import { RecoveryScreen } from './pages/RecoveryScreen'
import { TendersPage } from './pages/TendersPage'
import { TutorialsPage } from './pages/TutorialsPage'

/**
 * The discovery page's id in the sidebar.
 *
 * A plain string since `AppPage` (`shared/types.ts`) lists `'discover'` — no cast
 * and no page union of this file's own, so the store's `AppPage` travels through
 * the nav unchanged. It stays a named constant rather than an inline literal
 * because `tests/discovery-pane.test.ts` pins the nav item as
 * `page: DISCOVER_PAGE, label: 'Discover'`; the label itself is the part that
 * matters there (see the note on the nav item below).
 */
const DISCOVER_PAGE = 'discover'

const NAV_ITEMS: { page: AppPage; label: string; icon: React.ReactNode; tour?: string }[] = [
  { page: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
  { page: 'customers', label: 'Customers', icon: <Users size={18} /> },
  { page: 'documents', label: 'Documents', icon: <FileText size={18} /> },
  { page: 'tenders', label: 'Tenders', icon: <BookOpen size={18} /> },
  // "Discover" rather than "Find tenders": the page says "Find tenders", but a
  // sidebar item whose name contains "Tenders" is ambiguous — for a reader
  // looking at two items that both end in the word, and for every name-based
  // locator in the e2e suite (`getByRole('button', { name: 'Tenders' })` matches
  // a name case-insensitively as a substring, so it would resolve to two
  // buttons). The destination is named here, the task is named on the page.
  { page: DISCOVER_PAGE, label: 'Discover', icon: <Search size={18} /> },
  { page: 'profile', label: 'Company Profile', icon: <Building2 size={18} /> },
  {
    page: 'tutorials',
    label: 'Tutorials',
    icon: <GraduationCap size={18} />,
    tour: 'tour-tutorials-nav',
  },
]

/**
 * Create the isolated sample ("demo") workspace.
 *
 * The workspace carries `dataOrigin: 'demo'` so every surface can label it and
 * keep sample records out of real bid work (see contracts-and-invariants §1).
 * `addDemoWorkspace` forces that origin and persists through the authoritative
 * v2 store like any other mutation; it runs only from the explicit first-use
 * choice, only on an install that already has zero workspaces, and is never
 * used as a fallback when a real workspace is missing.
 */
function createSampleWorkspace(): string {
  const store = useTendersStore.getState()
  const id = `co-demo-${Date.now()}`
  store.addDemoWorkspace(createSampleWorkspaceRecord(id))
  return id
}

/**
 * Track a CSS media query. Used to auto-collapse the sidebar on narrow windows
 * so the workspace keeps usable width at 800×600; a manual toggle still works
 * on wider windows.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function App() {
  const page = useTendersStore((s) => s.page)
  const setPage = useTendersStore((s) => s.setPage)

  useEffect(() => {
    void useTendersStore.getState().hydrateFromMain()
  }, [])

  const hydrationStatus = useTendersStore((s) => s.hydrationStatus)
  const hydrationError = useTendersStore((s) => s.hydrationError)
  const recoveryRequired = useTendersStore((s) => s.recoveryRequired)
  const hasWorkspaces = useTendersStore((s) => s.hasWorkspaces)
  const saveStatus = useTendersStore((s) => s.saveStatus)
  const saveError = useTendersStore((s) => s.saveError)
  const saveSizeWarning = useTendersStore((s) => s.saveSizeWarning)
  const retrySave = useTendersStore((s) => s.retrySave)
  const reloadCommittedFromMain = useTendersStore((s) => s.reloadCommittedFromMain)

  const company = useTendersStore((s) => s.company)
  const workspaces = useTendersStore((s) => s.workspaces)
  const activeCompanyId = useTendersStore((s) => s.activeCompanyId)
  const setActiveCompany = useTendersStore((s) => s.setActiveCompany)
  const addCompany = useTendersStore((s) => s.addCompany)
  const [manualCollapsed, setManualCollapsed] = useState(false)
  const narrowWindow = useMediaQuery('(max-width: 900px)')
  const collapsed = manualCollapsed || narrowWindow
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [addingCompany, setAddingCompany] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [sampleBusy, setSampleBusy] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const onboardingDone = useTendersStore((s) => s.onboardingDone)
  const restartOnboarding = useTendersStore((s) => s.restartOnboarding)
  const startTour = useTendersStore((s) => s.startTour)

  const activeWorkspace = workspaces.find((ws) => ws.id === activeCompanyId) ?? null
  const activeIsSample = isSampleWorkspace(activeWorkspace)

  const handleExploreSample = useCallback(() => {
    setSampleError(null)
    setSampleBusy(true)
    try {
      createSampleWorkspace()
    } catch (error) {
      setSampleError(
        error instanceof Error
          ? error.message
          : 'The sample workspace could not be created. Try setting up a company instead.',
      )
    } finally {
      setSampleBusy(false)
    }
  }, [])

  if (hydrationStatus === 'loading') {
    return (
      <div
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center p-6 text-center"
        style={{ background: 'var(--gs-panel-bg)' }}
      >
        <div className="flex flex-col items-center gap-3">
          <Spinner className="size-6" />
          <p className="text-sm font-medium text-[var(--text-secondary)]">
            Loading Tenders workspace…
          </p>
        </div>
      </div>
    )
  }

  if (hydrationStatus === 'error' && recoveryRequired) {
    // Explicit recovery only: the main process never substitutes a backup or an
    // empty/demo document as authoritative.
    return <RecoveryScreen />
  }

  if (hydrationStatus === 'error') {
    return (
      <div
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center p-6 text-center"
        style={{ background: 'var(--gs-panel-bg)' }}
      >
        <div className="w-full max-w-md rounded-2xl border border-[var(--danger-border)] bg-[var(--surface)] p-8 text-center shadow-[var(--shadow-menu)]">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]">
            <AlertTriangle size={26} aria-hidden="true" />
          </span>

          <h1 className="mt-5 text-lg font-bold text-[var(--text)]">Unable to load Tenders data</h1>

          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            {hydrationError || 'An error occurred while reading Tenders persistence from disk.'}
          </p>

          <p className="mt-3 inline-flex items-center justify-center gap-1.5 text-xs text-[var(--text-tertiary)]">
            Data has not been modified or overwritten.
          </p>

          <div className="mt-6 flex justify-center">
            <Button
              variant="primary"
              onClick={() => void useTendersStore.getState().hydrateFromMain()}
              className="cursor-pointer"
            >
              Retry loading
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (hydrationStatus === 'ready' && !hasWorkspaces) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
          <SaveStatus
            status={saveStatus}
            message={saveError}
            warning={saveSizeWarning}
            onRetry={retrySave}
            onReload={reloadCommittedFromMain}
          />
        </div>
        <FirstUsePage
          onCreateCompany={() => setAddingCompany(true)}
          onExploreSample={handleExploreSample}
          sampleBusy={sampleBusy}
          sampleError={sampleError}
        />
        {addingCompany && (
          <CompanyFormDialog
            mode="create"
            onClose={() => setAddingCompany(false)}
            onSubmit={(profile) => {
              addCompany(profile)
              setAddingCompany(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside
        className={`relative flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-all duration-200 ${
          collapsed ? 'w-[60px]' : 'w-[220px]'
        }`}
      >
        {/* logo */}
        <div
          className={`flex h-14 shrink-0 items-center border-b border-[var(--border-subtle)] px-3 gap-2.5`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)]">
            <ShieldCheck size={16} />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span
                className="block truncate text-[13px] font-bold tracking-tight text-[var(--text)]"
                title="Zanostack Tenders"
              >
                Zanostack Tenders
              </span>
              <span
                className="block truncate text-[10px] text-[var(--text-tertiary)]"
                title="Bids & RFP Workspace"
              >
                Bids &amp; RFP Workspace
              </span>
            </span>
          )}
        </div>

        {/* save status — the collapsed sidebar is 60px wide, so the full pill
            would be clipped to its first letters; the compact variant keeps the
            status (and any retry/reload action) inside the rail. A size
            advisory survives the collapse through the glyph's title. */}
        <div
          className={`border-b border-[var(--border-subtle)] py-2 flex items-center ${collapsed ? 'justify-center px-1' : 'px-3'}`}
        >
          <SaveStatus
            status={saveStatus}
            message={saveError}
            warning={saveSizeWarning}
            onRetry={retrySave}
            onReload={reloadCommittedFromMain}
            compact={collapsed}
          />
        </div>

        {/* nav */}
        <nav
          className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3"
          data-tour="tour-nav"
        >
          {NAV_ITEMS.map((item) => {
            const active = page === item.page
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => setPage(item.page)}
                data-tour={item.tour}
                aria-label={item.label}
                title={item.label}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-dark)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
                }`}
              >
                <span
                  className={`shrink-0 ${active ? 'text-[var(--accent-dark)]' : 'text-[var(--text-tertiary)]'}`}
                >
                  {item.icon}
                </span>
                {!collapsed && <span className="truncate">{item.label}</span>}
              </button>
            )
          })}
        </nav>

        {/* help + onboarding shortcuts */}
        <div
          className="relative shrink-0 border-t border-[var(--border-subtle)]"
          data-tour="tour-help"
        >
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            aria-label="Help, tour & tutorials"
            title={collapsed ? 'Help, tour & tutorials' : undefined}
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover)] ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <HelpCircle size={15} className="shrink-0 text-[var(--text-tertiary)]" />
            {!collapsed && (
              <span className="text-[13px] font-medium text-[var(--text-secondary)]">
                Help &amp; tutorials
              </span>
            )}
          </button>

          {helpOpen && (
            <div className="absolute bottom-full left-2 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-menu)]">
              <button
                type="button"
                onClick={() => {
                  restartOnboarding()
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)]"
              >
                <ShieldCheck size={14} className="text-[var(--accent)]" /> Re-run welcome
                walkthrough
              </button>
              <button
                type="button"
                onClick={() => {
                  startTour()
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)]"
              >
                <LayoutDashboard size={14} className="text-[var(--accent)]" /> Take the guided tour
              </button>
              <button
                type="button"
                onClick={() => {
                  setLimitsOpen(true)
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)]"
              >
                <ShieldAlert size={14} className="text-[var(--warn)]" /> What Tenders does not do
              </button>
              <button
                type="button"
                onClick={() => {
                  setPage('tutorials')
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-[13px] font-medium text-[var(--accent-dark)] transition-colors hover:bg-[var(--hover)]"
              >
                <GraduationCap size={14} /> Open Tutorials page
              </button>
            </div>
          )}
        </div>

        {/* company identity footer + switcher */}
        <div
          className="relative shrink-0 border-t border-[var(--border-subtle)]"
          data-tour="tour-company-switcher"
        >
          <button
            type="button"
            onClick={() => setSwitcherOpen((v) => !v)}
            aria-label={`Switch company (active: ${company.tradingName})`}
            title={
              collapsed
                ? `Switch company (active: ${company.tradingName}${activeIsSample ? ' — sample workspace' : ''})`
                : activeIsSample
                  ? 'Active: sample workspace'
                  : 'Switch company'
            }
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left transition-colors hover:bg-[var(--hover)] ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${
                activeIsSample
                  ? 'bg-[var(--warn-bg)] text-[var(--warn)]'
                  : 'bg-[var(--accent-soft)] text-[var(--accent-dark)]'
              }`}
            >
              {company.tradingName.slice(0, 2).toUpperCase()}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--text)]">
                      {company.tradingName}
                    </span>
                    {activeIsSample && (
                      <span className="shrink-0 rounded-full bg-[var(--warn-bg)] px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-[var(--warn)]">
                        SAMPLE
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--text-tertiary)]">
                    {company.bbbeeLevel || 'No B-BBEE level'} · {company.industry || 'No sector'}
                  </span>
                </span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 text-[var(--text-tertiary)] transition-transform ${switcherOpen ? 'rotate-180' : ''}`}
                />
              </>
            )}
          </button>

          {switcherOpen && (
            <div className="absolute bottom-full left-2 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-menu)]">
              <p className="border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
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
                            ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent-dark)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                        }`}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--surface-subtle)] text-[9px] font-bold text-[var(--text-secondary)]">
                          {ws.company.tradingName.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{ws.company.tradingName}</span>
                        {isSampleWorkspace(ws) && (
                          <span className="shrink-0 rounded-full bg-[var(--warn-bg)] px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-[var(--warn)]">
                            SAMPLE
                          </span>
                        )}
                        {active && (
                          <Check size={13} className="shrink-0 text-[var(--accent-dark)]" />
                        )}
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
                className="flex w-full cursor-pointer items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-[13px] font-medium text-[var(--accent-dark)] transition-colors hover:bg-[var(--hover)]"
              >
                <Plus size={14} /> Add company
              </button>
            </div>
          )}
        </div>

        {/* collapse toggle */}
        <button
          type="button"
          onClick={() => setManualCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3 top-16 z-10 flex size-6 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] shadow-sm hover:text-[var(--text)]"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </aside>

      {/* ── New company dialog (full profile form) ─────────────────────────── */}
      {addingCompany && (
        <CompanyFormDialog
          mode="create"
          onClose={() => setAddingCompany(false)}
          onSubmit={(profile) => {
            addCompany(profile)
            setAddingCompany(false)
          }}
        />
      )}

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--canvas)]">
        {activeIsSample && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-2"
            role="region"
            aria-label="Sample workspace"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
              <Sparkles size={13} className="text-[var(--warn)]" aria-hidden="true" />
              Sample workspace
            </span>
            <span className="text-[11px] leading-snug text-[var(--text-secondary)]">
              Every record in this workspace is demonstration data. Create your own workspace before
              preparing a real bid.
            </span>
            <button
              type="button"
              onClick={() => setAddingCompany(true)}
              className="ml-auto cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              Create your workspace
            </button>
          </div>
        )}
        {page === 'discover' && <DiscoverPage />}
        {page === 'overview' && <OverviewPage />}
        {page === 'customers' && <CustomersPage />}
        {page === 'documents' && <DocumentsPage />}
        {page === 'tenders' && <TendersPage />}
        {page === 'profile' && <ProfilePage />}
        {page === 'tutorials' && <TutorialsPage />}
      </main>

      {/* ── Onboarding: first-launch walkthrough + interactive tour ────────── */}
      {!onboardingDone && <OnboardingModal />}
      {limitsOpen && <LimitationsNotice onClose={() => setLimitsOpen(false)} />}
      <GuidedTour />
    </div>
  )
}

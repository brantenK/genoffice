// Overview: KPI cards, doc health summary, recent expiry warnings, renewal
// runway timeline (+ .ics calendar export), quick actions.
import {
  AlertTriangle,
  BookOpen,
  Clock,
  CalendarClock,
  CalendarDays,
  FileText,
  Plus,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DocHealth } from '../../../shared/types'
import { buildRunway, downloadIcs, RUNWAY_KIND_LABEL, type RunwayItem } from '../../calendar'
import { useNow } from '../../deadline'
import { assessDocHealth } from '../../gap'
import { isSampleWorkspace } from '../../mock/sample-workspace'
import { useTendersStore } from '../../store'
import { CompanyFormDialog } from '../CompanyFormDialog'
import { CustomerFormDialog } from '../CustomerFormDialog'
import { Badge, Button } from '../ui'

const HEALTH_TONE: Record<DocHealth, 'green' | 'amber' | 'red' | 'slate'> = {
  VALID: 'green',
  EXPIRED: 'red',
  STALE_CERTIFICATION: 'amber',
  NO_EXPIRY_INFO: 'slate',
}

const HEALTH_LABEL: Record<DocHealth, string> = {
  VALID: 'Valid',
  EXPIRED: 'Expired',
  STALE_CERTIFICATION: 'Stale stamp',
  NO_EXPIRY_INFO: 'No expiry',
}

const SECTOR_COLORS: Record<string, string> = {
  Civil: 'bg-[var(--info)]',
  Electrical: 'bg-[var(--accent)]',
  Water: 'bg-[var(--success)]',
  Bidding: 'bg-[var(--warn)]',
}

const RUNWAY_TONE: Record<
  RunwayItem['kind'],
  { dot: string; badge: 'red' | 'amber' | 'sky' | 'violet' }
> = {
  VAULT_EXPIRY: { dot: 'bg-[var(--danger)]', badge: 'red' },
  STALE_STAMP: { dot: 'bg-[var(--warn)]', badge: 'amber' },
  TENDER_CLOSING: { dot: 'bg-[var(--info)]', badge: 'sky' },
  TENDER_SUBMIT_BY: { dot: 'bg-[var(--accent)]', badge: 'violet' },
}

export function OverviewPage() {
  const vault = useTendersStore((s) => s.vault)
  const customers = useTendersStore((s) => s.customers)
  const tenders = useTendersStore((s) => s.tenders)
  const company = useTendersStore((s) => s.company)
  const setPage = useTendersStore((s) => s.setPage)
  const addCustomer = useTendersStore((s) => s.addCustomer)
  const updateActiveCompany = useTendersStore((s) => s.updateActiveCompany)
  const sampleWorkspace = useTendersStore((s) =>
    isSampleWorkspace(s.workspaces.find((ws) => ws.id === s.activeCompanyId)),
  )
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false)
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false)
  const now = useNow(60_000)

  const docReports = useMemo(() => vault.map((d) => ({ doc: d, rep: assessDocHealth(d) })), [vault])
  const runway = useMemo(() => buildRunway(vault, tenders, now), [vault, tenders, now])
  const upcomingRunway = runway.filter((i) => i.daysAway >= 0)
  const expired = docReports.filter((r) => r.rep.health === 'EXPIRED')
  const stale = docReports.filter((r) => r.rep.health === 'STALE_CERTIFICATION')
  const valid = docReports.filter((r) => r.rep.health === 'VALID')
  const expiringWithin60 = docReports.filter(
    (r) => r.rep.health === 'VALID' && r.rep.daysUntilExpiry !== null && r.rep.daysUntilExpiry < 60,
  )
  const activeCustomers = customers.filter((c) => !c.archivedAt && c.status === 'ACTIVE').length
  const activeCustomersTotal = customers.filter((c) => !c.archivedAt).length
  const archivedCustomers = customers.filter((c) => c.archivedAt).length
  const activeTenders = tenders.length
  const completedProjects = company.projects.filter((p) => p.status === 'COMPLETED').length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* page header */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <h1 className="text-xl font-bold text-[var(--text)]">Overview</h1>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          {sampleWorkspace
            ? 'Sample workspace — these figures come from demonstration records, not your own data.'
            : `Welcome back — here's the health of ${company.tradingName}'s compliance workspace.`}
        </p>
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-8 px-8 py-8">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-tour="tour-kpi">
          <KpiCard
            icon={<FileText size={20} className="text-[var(--success)]" />}
            label="Vault documents"
            value={String(vault.length)}
            sub={`${valid.length} valid, ${expired.length} expired`}
            accent="bg-[var(--success-bg)]"
            onClick={() => setPage('documents')}
          />
          <KpiCard
            icon={<Users size={20} className="text-[var(--info)]" />}
            label="Active customers"
            value={String(activeCustomers)}
            sub={
              archivedCustomers > 0
                ? `${activeCustomersTotal} active · ${archivedCustomers} archived`
                : `${activeCustomersTotal} total on record`
            }
            accent="bg-[var(--info-bg)]"
            onClick={() => setPage('customers')}
          />
          <KpiCard
            icon={<BookOpen size={20} className="text-[var(--warn)]" />}
            label="Tenders loaded"
            value={String(activeTenders)}
            sub={activeTenders === 0 ? 'Load a tender RFP pack' : `${activeTenders} in workspace`}
            accent="bg-[var(--warn-bg)]"
            onClick={() => setPage('tenders')}
          />
          <KpiCard
            icon={<TrendingUp size={20} className="text-[var(--accent-dark)]" />}
            label="Projects completed"
            value={String(completedProjects)}
            sub={`of ${company.projects.length} total`}
            accent="bg-[var(--accent-soft)]"
            onClick={() => setPage('profile')}
          />
        </div>

        {/* attention banners */}
        {(expired.length > 0 || stale.length > 0 || expiringWithin60.length > 0) && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">Needs attention</h2>
            <div className="space-y-2">
              {expired.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<AlertTriangle size={15} className="text-[var(--danger)]" />}
                  title={doc.title}
                  detail={`Expired ${Math.abs(rep.daysUntilExpiry ?? 0)} days ago — renew before any submission`}
                  tone="border-[var(--danger-border)] bg-[var(--danger-bg)]"
                  badge={<Badge tone="red">Expired</Badge>}
                  onClick={() => setPage('documents')}
                />
              ))}
              {stale.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<Clock size={15} className="text-[var(--warn)]" />}
                  title={doc.title}
                  detail={`Police stamp is ${rep.daysSinceCertified} days old — exceeds the 90-day window`}
                  tone="border-[var(--warn-border)] bg-[var(--warn-bg)]"
                  badge={<Badge tone="amber">Stale stamp</Badge>}
                  onClick={() => setPage('documents')}
                />
              ))}
              {expiringWithin60.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<Clock size={15} className="text-[var(--info)]" />}
                  title={doc.title}
                  detail={`Expires in ${rep.daysUntilExpiry} days — plan renewal`}
                  tone="border-[var(--info-border)] bg-[var(--info-bg)]"
                  badge={<Badge tone="sky">Expiring soon</Badge>}
                  onClick={() => setPage('documents')}
                />
              ))}
            </div>
          </section>
        )}

        {/* document health summary + project pipeline side by side */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* doc health breakdown */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="mb-4 text-sm font-semibold text-[var(--text)]">Document vault health</h2>
            {docReports.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center">
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  No vault documents yet. Once they are on file, Tenders checks expiry dates and the
                  90-day police-stamp window for you.
                </p>
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-3"
                  onClick={() => setPage('documents')}
                >
                  <Plus size={12} /> Upload your first document
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {docReports.map(({ doc, rep }) => (
                  <div
                    key={doc.id}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-[var(--hover)]"
                    onClick={() => setPage('documents')}
                  >
                    <p className="min-w-0 truncate text-[13px] text-[var(--text-secondary)]">
                      {doc.title}
                    </p>
                    <Badge tone={HEALTH_TONE[rep.health]}>{HEALTH_LABEL[rep.health]}</Badge>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* project pipeline */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="mb-4 text-sm font-semibold text-[var(--text)]">Project track record</h2>
            {company.projects.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center">
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  No projects recorded yet. Similar-project references are one of the most commonly
                  requested returnables.
                </p>
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-3"
                  onClick={() => setCompanyDialogOpen(true)}
                >
                  <Plus size={12} /> Add a project
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {company.projects.map((p) => (
                  <div
                    key={p.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 hover:bg-[var(--hover)]"
                    onClick={() => setPage('profile')}
                  >
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${SECTOR_COLORS[p.sector] ?? 'bg-[var(--text-tertiary)]'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-[var(--text)]">
                        {p.title}
                      </p>
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        {p.client} · {p.value}
                      </p>
                    </div>
                    <StatusPill status={p.status} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* expiry runway timeline */}
        <section
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          data-tour="tour-runway"
        >
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">Renewal runway</h2>
            <Button
              size="sm"
              onClick={() => downloadIcs(upcomingRunway)}
              title="Download upcoming runway events as a calendar (.ics) file"
            >
              <CalendarDays size={13} /> Download .ics
            </Button>
          </div>
          <p className="mb-4 text-xs text-[var(--text-secondary)]">
            Everything with a date, in order — document expiries, 90-day police-stamp windows,
            tender closing dates and the recommended submit-by times.
          </p>
          {runway.length === 0 ? (
            <p className="rounded-lg bg-[var(--surface-subtle)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
              Nothing on the runway — add documents with expiry dates or shred a tender.
            </p>
          ) : (
            <ol className="relative space-y-3 border-l border-[var(--border)] pl-5">
              {runway.map((item) => (
                <RunwayRow key={item.id} item={item} />
              ))}
            </ol>
          )}
        </section>

        {/* quick actions */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">Quick actions</h2>
          <div className="flex flex-wrap gap-3">
            <QuickAction
              label="Add a customer"
              icon={<Users size={15} />}
              onClick={() => setCustomerDialogOpen(true)}
            />
            <QuickAction
              label="Upload a document"
              icon={<FileText size={15} />}
              onClick={() => setPage('documents')}
            />
            <QuickAction
              label="Shred a tender RFP"
              icon={<BookOpen size={15} />}
              onClick={() => setPage('tenders')}
            />
            <QuickAction
              label="Edit company profile"
              icon={<TrendingUp size={15} />}
              onClick={() => setCompanyDialogOpen(true)}
            />
          </div>
        </section>
      </div>

      {customerDialogOpen && (
        <CustomerFormDialog
          mode="create"
          vault={vault}
          onClose={() => setCustomerDialogOpen(false)}
          onSubmit={(customer) => {
            addCustomer(customer)
            setCustomerDialogOpen(false)
          }}
        />
      )}

      {companyDialogOpen && (
        <CompanyFormDialog
          mode="edit"
          initial={company}
          onClose={() => setCompanyDialogOpen(false)}
          onSubmit={(profile) => {
            updateActiveCompany(profile)
            setCompanyDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  accent: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left shadow-sm transition-shadow hover:shadow-md`}
    >
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
        {icon}
      </span>
      <div>
        <p className="text-[11px] text-[var(--text-secondary)]">{label}</p>
        <p className="mt-0.5 text-2xl font-bold text-[var(--text)]">{value}</p>
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{sub}</p>
      </div>
    </button>
  )
}

function AttentionRow({
  icon,
  title,
  detail,
  tone,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  tone: string
  badge: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left ${tone} hover:brightness-95`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-[var(--text)]">{title}</p>
        <p className="text-xs text-[var(--text-secondary)]">{detail}</p>
      </div>
      {badge}
    </button>
  )
}

function RunwayRow({ item }: { item: RunwayItem }) {
  const tone = RUNWAY_TONE[item.kind]
  const date = new Date(item.date)
  const overdue = item.daysAway < 0
  return (
    <li className="relative">
      <span
        className={`absolute -left-[26px] top-1.5 size-2.5 shrink-0 rounded-full ring-2 ring-[var(--surface)] ${tone.dot}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--text)]">
            {RUNWAY_KIND_LABEL[item.kind]} — {item.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={11} />
              {date.toLocaleDateString('en-ZA', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
            <span>{item.note}</span>
          </p>
        </div>
        <Badge tone={overdue ? 'red' : tone.badge}>
          {overdue ? `${Math.abs(item.daysAway)}d overdue` : `in ${item.daysAway}d`}
        </Badge>
      </div>
    </li>
  )
}

function StatusPill({ status }: { status: string }) {
  // Status is always carried by the label; the tint only reinforces it.
  const map: Record<string, string> = {
    COMPLETED: 'bg-[var(--success-bg)] text-[var(--color-brand-secondary)]',
    IN_PROGRESS: 'bg-[var(--info-bg)] text-[var(--info)]',
    BIDDING: 'bg-[var(--warn-bg)] text-[var(--warn)]',
    ON_HOLD: 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
  }
  const label: Record<string, string> = {
    COMPLETED: 'Done',
    IN_PROGRESS: 'Active',
    BIDDING: 'Bidding',
    ON_HOLD: 'On hold',
  }
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${map[status] ?? 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]'}`}
    >
      {label[status] ?? status}
    </span>
  )
}

function QuickAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] shadow-sm transition-shadow hover:shadow-md hover:text-[var(--accent-dark)]"
    >
      {icon} {label}
    </button>
  )
}

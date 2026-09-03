// Overview: KPI cards, doc health summary, recent expiry warnings, renewal
// runway timeline (+ .ics calendar export), quick actions.
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  CalendarClock,
  CalendarDays,
  FileText,
  TrendingUp,
  Users
} from 'lucide-react'
import { useMemo } from 'react'
import type { DocHealth } from '../../../shared/types'
import { buildRunway, downloadIcs, RUNWAY_KIND_LABEL, type RunwayItem } from '../../calendar'
import { useNow } from '../../deadline'
import { assessDocHealth } from '../../gap'
import { useTendersStore } from '../../store'
import { Badge, Button } from '../ui'

const HEALTH_TONE: Record<DocHealth, 'green' | 'amber' | 'red' | 'slate'> = {
  VALID: 'green',
  EXPIRED: 'red',
  STALE_CERTIFICATION: 'amber',
  NO_EXPIRY_INFO: 'slate'
}

const HEALTH_LABEL: Record<DocHealth, string> = {
  VALID: 'Valid',
  EXPIRED: 'Expired',
  STALE_CERTIFICATION: 'Stale stamp',
  NO_EXPIRY_INFO: 'No expiry'
}

const SECTOR_COLORS: Record<string, string> = {
  Civil: 'bg-sky-500',
  Electrical: 'bg-violet-500',
  Water: 'bg-teal-500',
  Bidding: 'bg-amber-400',
}

const RUNWAY_TONE: Record<RunwayItem['kind'], { dot: string; badge: 'red' | 'amber' | 'sky' | 'violet' }> = {
  VAULT_EXPIRY:    { dot: 'bg-red-500',    badge: 'red' },
  STALE_STAMP:     { dot: 'bg-amber-500',  badge: 'amber' },
  TENDER_CLOSING:  { dot: 'bg-sky-500',    badge: 'sky' },
  TENDER_SUBMIT_BY:{ dot: 'bg-violet-500', badge: 'violet' }
}

export function OverviewPage() {
  const vault = useTendersStore((s) => s.vault)
  const customers = useTendersStore((s) => s.customers)
  const tenders = useTendersStore((s) => s.tenders)
  const company = useTendersStore((s) => s.company)
  const setPage = useTendersStore((s) => s.setPage)
  const now = useNow(60_000)

  const docReports = useMemo(
    () => vault.map((d) => ({ doc: d, rep: assessDocHealth(d) })),
    [vault]
  )
  const runway = useMemo(
    () => buildRunway(vault, tenders, now),
    [vault, tenders, now]
  )
  const upcomingRunway = runway.filter((i) => i.daysAway >= 0)
  const expired = docReports.filter((r) => r.rep.health === 'EXPIRED')
  const stale   = docReports.filter((r) => r.rep.health === 'STALE_CERTIFICATION')
  const valid   = docReports.filter((r) => r.rep.health === 'VALID')
  const expiringWithin60 = docReports.filter(
    (r) => r.rep.health === 'VALID' && r.rep.daysUntilExpiry !== null && r.rep.daysUntilExpiry < 60
  )
  const activeCustomers = customers.filter((c) => c.status === 'ACTIVE').length
  const activeTenders   = tenders.length
  const completedProjects = company.projects.filter((p) => p.status === 'COMPLETED').length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* page header */}
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <h1 className="text-xl font-bold text-slate-900">Overview</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Welcome back — here's the health of {company.tradingName}'s compliance workspace.
        </p>
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-8 px-8 py-8">

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-tour="tour-kpi">
          <KpiCard
            icon={<FileText size={20} className="text-indigo-500" />}
            label="Vault documents"
            value={String(vault.length)}
            sub={`${valid.length} valid, ${expired.length} expired`}
            accent="bg-indigo-50"
            onClick={() => setPage('documents')}
          />
          <KpiCard
            icon={<Users size={20} className="text-sky-500" />}
            label="Active customers"
            value={String(activeCustomers)}
            sub={`${customers.length} total on record`}
            accent="bg-sky-50"
            onClick={() => setPage('customers')}
          />
          <KpiCard
            icon={<BookOpen size={20} className="text-violet-500" />}
            label="Tenders loaded"
            value={String(activeTenders)}
            sub={activeTenders === 0 ? 'Load a tender RFP pack' : `${activeTenders} in workspace`}
            accent="bg-violet-50"
            onClick={() => setPage('tenders')}
          />
          <KpiCard
            icon={<TrendingUp size={20} className="text-emerald-500" />}
            label="Projects completed"
            value={String(completedProjects)}
            sub={`of ${company.projects.length} total`}
            accent="bg-emerald-50"
            onClick={() => setPage('profile')}
          />
        </div>

        {/* attention banners */}
        {(expired.length > 0 || stale.length > 0 || expiringWithin60.length > 0) && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Needs attention</h2>
            <div className="space-y-2">
              {expired.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<AlertTriangle size={15} className="text-red-500" />}
                  title={doc.title}
                  detail={`Expired ${Math.abs(rep.daysUntilExpiry ?? 0)} days ago — renew before any submission`}
                  tone="border-red-200 bg-red-50"
                  badge={<Badge tone="red">Expired</Badge>}
                  onClick={() => setPage('documents')}
                />
              ))}
              {stale.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<Clock size={15} className="text-amber-500" />}
                  title={doc.title}
                  detail={`Police stamp is ${rep.daysSinceCertified} days old — exceeds the 90-day window`}
                  tone="border-amber-200 bg-amber-50"
                  badge={<Badge tone="amber">Stale stamp</Badge>}
                  onClick={() => setPage('documents')}
                />
              ))}
              {expiringWithin60.map(({ doc, rep }) => (
                <AttentionRow
                  key={doc.id}
                  icon={<Clock size={15} className="text-sky-500" />}
                  title={doc.title}
                  detail={`Expires in ${rep.daysUntilExpiry} days — plan renewal`}
                  tone="border-sky-200 bg-sky-50"
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
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-800">Document vault health</h2>
            <div className="space-y-2">
              {docReports.map(({ doc, rep }) => (
                <div
                  key={doc.id}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setPage('documents')}
                >
                  <p className="min-w-0 truncate text-[13px] text-slate-700">{doc.title}</p>
                  <Badge tone={HEALTH_TONE[rep.health]}>{HEALTH_LABEL[rep.health]}</Badge>
                </div>
              ))}
            </div>
          </section>

          {/* project pipeline */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-800">Project pipeline</h2>
            <div className="space-y-2">
              {company.projects.map((p) => (
                <div
                  key={p.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setPage('profile')}
                >
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${SECTOR_COLORS[p.sector] ?? 'bg-slate-400'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-slate-800">{p.title}</p>
                    <p className="text-[11px] text-slate-500">{p.client} · {p.value}</p>
                  </div>
                  <StatusPill status={p.status} />
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* expiry runway timeline */}
        <section className="rounded-xl border border-slate-200 bg-white p-5" data-tour="tour-runway">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">Renewal runway</h2>
            <Button
              size="sm"
              onClick={() => downloadIcs(upcomingRunway)}
              title="Download upcoming runway events as a calendar (.ics) file"
            >
              <CalendarDays size={13} /> Download .ics
            </Button>
          </div>
          <p className="mb-4 text-xs text-slate-400">
            Everything with a date, in order — document expiries, 90-day police-stamp windows,
            tender closing dates and the recommended submit-by times.
          </p>
          {runway.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
              Nothing on the runway — add documents with expiry dates or shred a tender.
            </p>
          ) : (
            <ol className="relative space-y-3 border-l border-slate-200 pl-5">
              {runway.map((item) => (
                <RunwayRow key={item.id} item={item} />
              ))}
            </ol>
          )}
        </section>

        {/* quick actions */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Quick actions</h2>
          <div className="flex flex-wrap gap-3">
            <QuickAction label="Add a customer" icon={<Users size={15} />} onClick={() => setPage('customers')} />
            <QuickAction label="Upload a document" icon={<FileText size={15} />} onClick={() => setPage('documents')} />
            <QuickAction label="Shred a tender RFP" icon={<BookOpen size={15} />} onClick={() => setPage('tenders')} />
            <QuickAction label="Edit company profile" icon={<TrendingUp size={15} />} onClick={() => setPage('profile')} />
          </div>
        </section>
      </div>
    </div>
  )
}

function KpiCard({
  icon, label, value, sub, accent, onClick
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
      className={`group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md`}
    >
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
        {icon}
      </span>
      <div>
        <p className="text-[11px] text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold text-slate-900">{value}</p>
        <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>
      </div>
    </button>
  )
}

function AttentionRow({
  icon, title, detail, tone, badge, onClick
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
        <p className="text-[13px] font-semibold text-slate-800">{title}</p>
        <p className="text-xs text-slate-600">{detail}</p>
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
        className={`absolute -left-[26px] top-1.5 size-2.5 shrink-0 rounded-full ring-2 ring-white ${tone.dot}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-slate-800">
            {RUNWAY_KIND_LABEL[item.kind]} — {item.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={11} />
              {date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
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
  const map: Record<string, string> = {
    COMPLETED:   'bg-emerald-100 text-emerald-700',
    IN_PROGRESS: 'bg-sky-100 text-sky-700',
    BIDDING:     'bg-amber-100 text-amber-700',
    ON_HOLD:     'bg-slate-100 text-slate-600',
  }
  const label: Record<string, string> = {
    COMPLETED: 'Done', IN_PROGRESS: 'Active', BIDDING: 'Bidding', ON_HOLD: 'On hold'
  }
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${map[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {label[status] ?? status}
    </span>
  )
}

function QuickAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition-shadow hover:shadow-md hover:text-indigo-700"
    >
      {icon} {label}
    </button>
  )
}

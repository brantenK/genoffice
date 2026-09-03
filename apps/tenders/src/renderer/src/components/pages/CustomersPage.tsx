// Customers: table of clients + per-customer doc requirements panel.
import { useState } from 'react'
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Mail,
  Phone,
  User,
  XCircle
} from 'lucide-react'
import type { Customer, CustomerStatus, DocCategory } from '../../../shared/types'
import { useTendersStore } from '../../store'
import { Badge } from '../ui'

const STATUS_TONE: Record<CustomerStatus, 'green' | 'sky' | 'slate'> = {
  ACTIVE: 'green',
  PROSPECT: 'sky',
  INACTIVE: 'slate'
}

const DOC_CAT_COLOR: Record<DocCategory, string> = {
  COMPLIANCE: 'text-indigo-600',
  FINANCIAL: 'text-emerald-600',
  TECHNICAL: 'text-sky-600',
  GOVERNANCE: 'text-violet-600',
  CV: 'text-amber-600'
}

export function CustomersPage() {
  const customers = useTendersStore((s) => s.customers)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<CustomerStatus | 'ALL'>('ALL')

  const selected = customers.find((c) => c.id === selectedId) ?? null
  const shown = filter === 'ALL' ? customers : customers.filter((c) => c.status === filter)

  if (selected) {
    return <CustomerDetail customer={selected} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <h1 className="text-xl font-bold text-slate-900">Customers</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Track required compliance documents for each client or prospect.
        </p>
      </div>

      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        {/* filter tabs */}
        <div className="mb-5 flex items-center gap-2">
          {(['ALL', 'ACTIVE', 'PROSPECT', 'INACTIVE'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                filter === s
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
              {' '}({s === 'ALL' ? customers.length : customers.filter((c) => c.status === s).length})
            </button>
          ))}
        </div>

        {/* customer cards grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((c) => {
            const fulfilled = c.requiredDocs.filter((d) => d.fulfilled).length
            const total = c.requiredDocs.length
            const pct = total > 0 ? Math.round((fulfilled / total) * 100) : 0
            const issues = c.requiredDocs.filter((d) => !d.fulfilled).length
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="group cursor-pointer rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">
                      {c.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">{c.industry}</p>
                  </div>
                  <Badge tone={STATUS_TONE[c.status]}>
                    {c.status.charAt(0) + c.status.slice(1).toLowerCase()}
                  </Badge>
                </div>

                {/* progress bar */}
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{fulfilled}/{total} docs ready</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : issues > 0 ? 'bg-amber-400' : 'bg-indigo-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <p className="text-[11px] text-slate-400">Since {c.since}</p>
                  {issues > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600">
                      <XCircle size={11} /> {issues} missing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                      <CheckCircle2 size={11} /> All documents ready
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {shown.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">
            No customers match this filter.
          </p>
        )}
      </div>
    </div>
  )
}

function CustomerDetail({ customer, onBack }: { customer: Customer; onBack: () => void }) {
  const vault = useTendersStore((s) => s.vault)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft size={14} /> Back to customers
        </button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{customer.name}</h1>
            <p className="mt-0.5 text-sm text-slate-500">{customer.industry} · Client since {customer.since}</p>
          </div>
          <Badge tone={STATUS_TONE[customer.status]}>
            {customer.status.charAt(0) + customer.status.slice(1).toLowerCase()}
          </Badge>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-8 py-8 lg:grid-cols-3">
        {/* left: contact + notes */}
        <div className="space-y-4 lg:col-span-1">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">Contact person</h2>
            <div className="space-y-2.5 text-sm text-slate-700">
              <div className="flex items-center gap-2">
                <User size={14} className="shrink-0 text-slate-400" />
                {customer.contactName}
              </div>
              <div className="flex items-center gap-2">
                <Mail size={14} className="shrink-0 text-slate-400" />
                <a href={`mailto:${customer.contactEmail}`} className="text-indigo-600 hover:underline">
                  {customer.contactEmail}
                </a>
              </div>
              <div className="flex items-center gap-2">
                <Phone size={14} className="shrink-0 text-slate-400" />
                {customer.contactPhone}
              </div>
            </div>
          </section>

          {customer.notes && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Notes</h2>
              <p className="text-sm leading-relaxed text-slate-600">{customer.notes}</p>
            </section>
          )}
        </div>

        {/* right: required docs tracker */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-800">
            Required documents
            <span className="ml-2 text-[11px] font-normal text-slate-400">
              {customer.requiredDocs.filter((d) => d.fulfilled).length}/{customer.requiredDocs.length} ready
            </span>
          </h2>
          <ul className="divide-y divide-slate-100">
            {customer.requiredDocs.map((req, i) => {
              const linked = req.linkedVaultDocId
                ? vault.find((v) => v.id === req.linkedVaultDocId)
                : null
              return (
                <li key={i} className="flex items-start gap-3 py-3">
                  {req.fulfilled ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-slate-800">{req.label}</p>
                    {linked && (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Linked: <span className="font-medium text-indigo-700">{linked.title}</span>
                        {linked.expiryDate && <> · expires {linked.expiryDate}</>}
                      </p>
                    )}
                    {!linked && (
                      <p className="mt-0.5 text-[11px] text-slate-400">No vault document linked</p>
                    )}
                  </div>
                  <span className={`shrink-0 text-[11px] font-medium ${DOC_CAT_COLOR[req.docCategory]}`}>
                    {req.docCategory.charAt(0) + req.docCategory.slice(1).toLowerCase()}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}

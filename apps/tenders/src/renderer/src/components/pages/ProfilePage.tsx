// Company Profile: identity, B-BBEE / registration info, directors, project portfolio.
import { useState } from 'react'
import {
  Award,
  Briefcase,
  Building2,
  Globe,
  Mail,
  MapPin,
  Phone,
  Users
} from 'lucide-react'
import type { ProjectStatus } from '../../../shared/types'
import { useTendersStore } from '../../store'
import { Badge } from '../ui'

const PROJECT_STATUS_TONE: Record<ProjectStatus, 'green' | 'sky' | 'amber' | 'slate'> = {
  COMPLETED: 'green',
  IN_PROGRESS: 'sky',
  BIDDING: 'amber',
  ON_HOLD: 'slate'
}

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  COMPLETED: 'Completed',
  IN_PROGRESS: 'In progress',
  BIDDING: 'Bidding',
  ON_HOLD: 'On hold'
}

const SECTOR_BG: Record<string, string> = {
  Civil: 'bg-sky-100 text-sky-700',
  Electrical: 'bg-violet-100 text-violet-700',
  Water: 'bg-teal-100 text-teal-700',
}

export function ProfilePage() {
  const company = useTendersStore((s) => s.company)
  const [projectFilter, setProjectFilter] = useState<ProjectStatus | 'ALL'>('ALL')

  const shownProjects =
    projectFilter === 'ALL'
      ? company.projects
      : company.projects.filter((p) => p.status === projectFilter)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header banner */}
      <div className="border-b border-slate-200 bg-white px-8 py-6">
        <div className="flex items-start gap-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <Building2 size={26} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900">{company.name}</h1>
            <p className="mt-0.5 text-sm text-slate-500">{company.industry} · Est. {company.founded} · {company.employees} employees</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="indigo">{company.bbbeeLevel}</Badge>
              <Badge tone="green">{company.bbbeeBlackOwnership} Black-owned</Badge>
              <Badge tone="slate">Reg {company.registrationNumber}</Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <div className="grid gap-6 lg:grid-cols-3">

          {/* left column: identity & contact */}
          <div className="space-y-5 lg:col-span-1">
            {/* contact */}
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">Contact</h2>
              <div className="space-y-2.5 text-sm text-slate-700">
                <div className="flex items-start gap-2">
                  <MapPin size={14} className="mt-0.5 shrink-0 text-slate-400" />
                  <span>{company.address}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Phone size={14} className="shrink-0 text-slate-400" />
                  {company.phone}
                </div>
                <div className="flex items-center gap-2">
                  <Mail size={14} className="shrink-0 text-slate-400" />
                  <a href={`mailto:${company.email}`} className="text-indigo-600 hover:underline">
                    {company.email}
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <Globe size={14} className="shrink-0 text-slate-400" />
                  {company.website}
                </div>
              </div>
            </section>

            {/* registration */}
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">Registration &amp; compliance</h2>
              <dl className="space-y-2">
                {[
                  ['CIPC Reg No', company.registrationNumber],
                  ['VAT Number', company.vatNumber],
                  ['SARS TCS PIN', company.taxPin],
                  ['CSD Supplier No', company.csdSupplierNumber],
                  ['B-BBEE Level', company.bbbeeLevel],
                  ['Black Ownership', company.bbbeeBlackOwnership],
                ].map(([label, val]) => (
                  <div key={label} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <dt className="text-slate-400">{label}</dt>
                    <dd className="truncate text-right font-medium text-slate-700">{val}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* directors */}
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                <Users size={14} className="text-slate-400" /> Directors
              </h2>
              <ul className="space-y-3">
                {company.directors.map((d) => (
                  <li key={d.name} className="flex items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                      {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-800">{d.name}</p>
                      <p className="text-[11px] text-slate-500">{d.role}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* right column: about + projects */}
          <div className="space-y-6 lg:col-span-2">
            {/* about */}
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">About</h2>
              <p className="text-sm leading-relaxed text-slate-600">{company.description}</p>
            </section>

            {/* project portfolio */}
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  <Briefcase size={14} className="text-slate-400" /> Project portfolio
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    ({company.projects.filter((p) => p.status === 'COMPLETED').length} completed)
                  </span>
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {(['ALL', 'COMPLETED', 'IN_PROGRESS', 'BIDDING'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setProjectFilter(s)}
                      className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        projectFilter === s
                          ? 'bg-slate-800 text-white'
                          : 'border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {s === 'ALL' ? 'All' : PROJECT_STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                {shownProjects.map((p) => (
                  <div key={p.id} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-slate-800">{p.title}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{p.client}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Badge tone={PROJECT_STATUS_TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Badge>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SECTOR_BG[p.sector] ?? 'bg-slate-100 text-slate-600'}`}>
                          {p.sector}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <Award size={11} /> {p.value}
                      </span>
                      <span>{p.period}</span>
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-slate-600">{p.description}</p>
                  </div>
                ))}
                {shownProjects.length === 0 && (
                  <p className="py-4 text-center text-sm text-slate-400">No projects match this filter.</p>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

// Company Profile — identity, registration/compliance, directors, capability text
// and project track record, all editable (Phase 4, WP-8).
//
// The page is also where the workspace lifecycle lives: archiving and permanent
// deletion are shown honestly — the affordances exist, explain what they would
// touch, and stay disabled until the store's archive/restore actions (and the
// deferred managed-file/trash semantics) land.
import { useState } from 'react'
import {
  Archive,
  Award,
  Briefcase,
  Building2,
  Globe,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import type { ProjectStatus } from '../../../shared/types'
import { isSampleWorkspace } from '../../mock/sample-workspace'
import { useTendersStore } from '../../store'
import { CompanyFormDialog } from '../CompanyFormDialog'
import { Badge, Button } from '../ui'

const PROJECT_STATUS_TONE: Record<ProjectStatus, 'green' | 'sky' | 'amber' | 'slate'> = {
  COMPLETED: 'green',
  IN_PROGRESS: 'sky',
  BIDDING: 'amber',
  ON_HOLD: 'slate',
}

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  COMPLETED: 'Completed',
  IN_PROGRESS: 'In progress',
  BIDDING: 'Bidding',
  ON_HOLD: 'On hold',
}

const SECTOR_BG: Record<string, string> = {
  Civil: 'bg-sky-100 text-sky-700',
  Electrical: 'bg-violet-100 text-violet-700',
  Water: 'bg-teal-100 text-teal-700',
}

export function ProfilePage() {
  const company = useTendersStore((s) => s.company)
  const tenders = useTendersStore((s) => s.tenders)
  const vault = useTendersStore((s) => s.vault)
  const customers = useTendersStore((s) => s.customers)
  const workspaces = useTendersStore((s) => s.workspaces)
  const activeCompanyId = useTendersStore((s) => s.activeCompanyId)
  const updateActiveCompany = useTendersStore((s) => s.updateActiveCompany)
  const archiveCompany = useTendersStore((s) => s.archiveCompany)
  const restoreCompany = useTendersStore((s) => s.restoreCompany)
  const [projectFilter, setProjectFilter] = useState<ProjectStatus | 'ALL'>('ALL')
  const [editing, setEditing] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const sampleWorkspace = isSampleWorkspace(
    workspaces.find((ws) => ws.id === activeCompanyId) ?? null,
  )
  const archived = Boolean(company.archivedAt)
  const archivedLabel =
    company.archivedAt && !isNaN(new Date(company.archivedAt).getTime())
      ? new Date(company.archivedAt).toLocaleDateString('en-ZA', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null

  const shownProjects =
    projectFilter === 'ALL'
      ? company.projects
      : company.projects.filter((p) => p.status === projectFilter)

  const missing: string[] = []
  if (!company.registrationNumber) missing.push('registration number')
  if (!company.vatNumber) missing.push('VAT number')
  if (!company.taxPin) missing.push('tax / TCS PIN')
  if (!company.csdSupplierNumber) missing.push('CSD supplier number')
  if (!company.bbbeeLevel) missing.push('B-BBEE level')
  if (company.directors.length === 0) missing.push('directors')
  if (!company.description) missing.push('capability statement')
  if (company.projects.length === 0) missing.push('project track record')

  const hasContact = Boolean(company.address || company.phone || company.email || company.website)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header banner */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-6">
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--accent-contrast)]">
            <Building2 size={26} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-[var(--text)]">
                {company.name || company.tradingName || 'Unnamed company'}
              </h1>
              {sampleWorkspace && (
                <Badge tone="amber" className="ring-1 ring-[var(--warn-border)]">
                  <Sparkles size={11} /> Sample workspace
                </Badge>
              )}
              {archived && <Badge tone="slate">Archived</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              {[
                company.industry,
                company.founded && `Est. ${company.founded}`,
                company.employees && `${company.employees} employees`,
              ]
                .filter(Boolean)
                .join(' · ') || 'No industry, founding year or headcount recorded yet.'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {company.bbbeeLevel ? (
                <Badge tone="indigo">{company.bbbeeLevel}</Badge>
              ) : (
                <Badge tone="slate">No B-BBEE level</Badge>
              )}
              {company.bbbeeBlackOwnership && (
                <Badge tone="green">{company.bbbeeBlackOwnership} black-owned</Badge>
              )}
              {company.registrationNumber ? (
                <Badge tone="slate">Reg {company.registrationNumber}</Badge>
              ) : (
                <Badge tone="slate">No registration number</Badge>
              )}
            </div>
          </div>
          <Button
            variant="primary"
            onClick={() => setEditing(true)}
            title="Edit the company profile used by bid readiness and gap analysis"
          >
            <Pencil size={14} /> Edit profile
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        {missing.length > 0 && (
          <section className="mb-6 flex flex-wrap items-start gap-3 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3">
            <ShieldAlert
              size={16}
              className="mt-0.5 shrink-0 text-[var(--warn)]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--text)]">
                Complete company profile
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                Readiness and gap analysis flag these when a tender demands them:{' '}
                {missing.join(', ')}.
              </p>
            </div>
            <Button variant="default" onClick={() => setEditing(true)}>
              <Pencil size={13} /> Complete profile
            </Button>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* left column: identity & contact */}
          <div className="space-y-5 lg:col-span-1">
            {/* contact */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--text)]">Contact</h2>
                {!hasContact && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex min-h-6 cursor-pointer items-center text-[11px] font-medium text-[var(--accent-dark)] hover:text-[var(--text)]"
                  >
                    Add contact details
                  </button>
                )}
              </div>
              {hasContact ? (
                <div className="space-y-2.5 text-sm text-[var(--text-secondary)]">
                  {company.address && (
                    <div className="flex items-start gap-2">
                      <MapPin size={14} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
                      <span>{company.address}</span>
                    </div>
                  )}
                  {company.phone && (
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                      {company.phone}
                    </div>
                  )}
                  {company.email && (
                    <div className="flex items-center gap-2">
                      <Mail size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                      <a
                        href={`mailto:${company.email}`}
                        className="inline-flex min-h-6 items-center text-[var(--accent-dark)] hover:underline"
                      >
                        {company.email}
                      </a>
                    </div>
                  )}
                  {company.website && (
                    <div className="flex items-center gap-2">
                      <Globe size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                      {company.website}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  No address, phone or e-mail recorded yet. Tender forms usually ask for all three.
                </p>
              )}
            </section>

            {/* registration */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">
                Registration &amp; compliance
              </h2>
              <dl className="space-y-2">
                {[
                  ['CIPC Reg No', company.registrationNumber],
                  ['VAT Number', company.vatNumber],
                  ['SARS TCS PIN', company.taxPin],
                  ['CSD Supplier No', company.csdSupplierNumber],
                  ['B-BBEE Level', company.bbbeeLevel],
                  ['Black Ownership', company.bbbeeBlackOwnership],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-2 text-[12px]"
                  >
                    <dt className="text-[var(--text-tertiary)]">{label}</dt>
                    <dd
                      className={`truncate text-right font-medium ${value ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'}`}
                    >
                      {value || 'Not provided'}
                    </dd>
                  </div>
                ))}
              </dl>
              {!company.registrationNumber && !company.vatNumber && !company.taxPin && (
                <Button
                  size="sm"
                  variant="default"
                  className="mt-3"
                  onClick={() => setEditing(true)}
                >
                  <Plus size={13} /> Add registration details
                </Button>
              )}
            </section>

            {/* directors */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
                  <Users size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                  Directors
                </h2>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex min-h-6 cursor-pointer items-center text-[11px] font-medium text-[var(--accent-dark)] hover:text-[var(--text)]"
                >
                  Add director
                </button>
              </div>
              {company.directors.length === 0 ? (
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  No directors recorded yet. Most returnable forms need the people who may sign for
                  the company.
                </p>
              ) : (
                <ul className="space-y-3">
                  {company.directors.map((director) => (
                    <li
                      key={`${director.name}-${director.idNumber}`}
                      className="flex items-center gap-3"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-subtle)] text-xs font-bold text-[var(--text-secondary)]">
                        {director.name
                          .split(' ')
                          .map((part) => part[0])
                          .join('')
                          .slice(0, 2)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-[var(--text)]">
                          {director.name || 'Unnamed director'}
                        </p>
                        <p className="text-[11px] text-[var(--text-tertiary)]">
                          {director.role || 'Role not stated'}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* right column: about + projects + workspace lifecycle */}
          <div className="space-y-6 lg:col-span-2">
            {/* about */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--text)]">Capability statement</h2>
                {!company.description && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex min-h-6 cursor-pointer items-center text-[11px] font-medium text-[var(--accent-dark)] hover:text-[var(--text)]"
                  >
                    Add a capability statement
                  </button>
                )}
              </div>
              {company.description ? (
                <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                  {company.description}
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  Nothing recorded yet. Describe the services, sectors and capacity the company can
                  deliver — Tenders uses this in the profile summary and never writes it for you.
                </p>
              )}
            </section>

            {/* project portfolio */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
                  <Briefcase size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                  Project track record
                  <span className="ml-1 text-[11px] font-normal text-[var(--text-tertiary)]">
                    ({company.projects.filter((p) => p.status === 'COMPLETED').length} completed)
                  </span>
                </h2>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['ALL', 'COMPLETED', 'IN_PROGRESS', 'BIDDING'] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setProjectFilter(status)}
                      className={`inline-flex min-h-6 cursor-pointer items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        projectFilter === status
                          ? 'bg-[var(--text)] text-[var(--surface)]'
                          : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                      }`}
                    >
                      {status === 'ALL' ? 'All' : PROJECT_STATUS_LABEL[status]}
                    </button>
                  ))}
                  <Button size="sm" variant="default" onClick={() => setEditing(true)}>
                    <Plus size={13} /> Add project
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {shownProjects.map((project) => (
                  <div
                    key={project.id}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--text)]">
                          {project.title || 'Untitled project'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                          {project.client || 'Client not stated'}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Badge tone={PROJECT_STATUS_TONE[project.status]}>
                          {PROJECT_STATUS_LABEL[project.status]}
                        </Badge>
                        {project.sector && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SECTOR_BG[project.sector] ?? 'bg-slate-100 text-slate-600'}`}
                          >
                            {project.sector}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 text-[11px] text-[var(--text-tertiary)]">
                      {project.value && (
                        <span className="flex items-center gap-1">
                          <Award size={11} aria-hidden="true" /> {project.value}
                        </span>
                      )}
                      {project.period && <span>{project.period}</span>}
                    </div>
                    {project.description && (
                      <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                        {project.description}
                      </p>
                    )}
                  </div>
                ))}
                {shownProjects.length === 0 && (
                  <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center">
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {company.projects.length === 0
                        ? 'No projects recorded yet. Similar-project references are one of the most requested returnables.'
                        : 'No projects match this filter.'}
                    </p>
                    {company.projects.length === 0 && (
                      <Button
                        size="sm"
                        variant="primary"
                        className="mt-3"
                        onClick={() => setEditing(true)}
                      >
                        <Plus size={13} /> Add your first project
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* workspace lifecycle */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="text-sm font-semibold text-[var(--text)]">Workspace lifecycle</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                Archiving sets a workspace aside without losing anything, and you can restore it at
                any time.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {archived ? (
                  <>
                    <Badge tone="amber">Archived{archivedLabel ? ` ${archivedLabel}` : ''}</Badge>
                    <Button
                      variant="primary"
                      disabled={!activeCompanyId}
                      onClick={() => activeCompanyId && restoreCompany(activeCompanyId)}
                      title="Make this workspace active again"
                    >
                      <RotateCcw size={13} /> Restore workspace
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="default"
                    disabled={!activeCompanyId}
                    onClick={() => activeCompanyId && archiveCompany(activeCompanyId)}
                    title="Set this workspace aside without deleting anything"
                  >
                    <Archive size={13} /> Archive this workspace
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setDeleteOpen((open) => !open)}
                  aria-expanded={deleteOpen}
                  title="See what a permanent delete would affect"
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-bg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                >
                  <Trash2 size={13} aria-hidden="true" /> Delete this workspace…
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                Archiving is reversible and keeps every record. Tenders offers no permanent
                workspace delete, and nothing erases files: a vault document you remove is moved to
                Trash, where you can restore it.
              </p>

              {deleteOpen && (
                <div className="mt-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3">
                  <p className="text-[13px] font-semibold text-[var(--text)]">
                    Permanent deletion is not available yet
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    Deleting “{company.tradingName || 'this workspace'}” would remove every record
                    it owns:
                  </p>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-[var(--text-secondary)]">
                    <li>
                      {tenders.length} tender{tenders.length === 1 ? '' : 's'} and their compliance
                      matrices
                    </li>
                    <li>
                      {vault.length} vault document{vault.length === 1 ? '' : 's'}
                    </li>
                    <li>
                      {customers.length} customer{customers.length === 1 ? '' : 's'}
                    </li>
                    <li>
                      {company.projects.length} project record
                      {company.projects.length === 1 ? '' : 's'} on the company profile
                    </li>
                  </ul>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="danger"
                      disabled
                      title="Permanent deletion is not offered — archive the workspace instead, or remove individual documents (they move to Trash and can be restored)"
                    >
                      <Trash2 size={13} /> Delete permanently
                    </Button>
                    <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                      Keep this workspace
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {editing && (
        <CompanyFormDialog
          mode="edit"
          initial={company}
          onClose={() => setEditing(false)}
          onSubmit={(profile) => {
            updateActiveCompany(profile)
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}

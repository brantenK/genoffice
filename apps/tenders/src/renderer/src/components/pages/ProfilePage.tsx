// Company Profile — identity, registration/compliance, directors, capability text
// and project track record, all editable (Phase 4, WP-8).
//
// The page is also where the workspace lifecycle lives: archiving and permanent
// deletion are shown honestly — archive/restore are real actions, and the
// destructive path is explained (there is no permanent workspace delete in the
// store) instead of being rendered as a permanently-disabled button.
//
// The deadline-reminder settings surface is at the foot of this file: the
// reminder schedule and its notification path already existed with no way for a
// user to see or retune them. Its copy rules are in that section's own header.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Award,
  Bell,
  Briefcase,
  Building2,
  Globe,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
  X,
  XCircle,
} from 'lucide-react'
import {
  MAX_TENDERS_REMINDER_LEAD_MS,
  MAX_TENDERS_REMINDER_THRESHOLDS,
} from '../../../../shared/ipc'
import { formatDeadlineDelta, parseClosingDate } from '../../../../shared/readiness'
import {
  DEFAULT_REMINDER_THRESHOLDS,
  describeReminder,
  isOpenTenderStatus,
  nextReminderAt,
  type DueReminder,
  type ReminderLedger,
  type ReminderSettings,
  type ReminderThreshold,
  type ReminderTender,
} from '../../../../shared/reminders'
import type { ProjectStatus } from '../../../shared/types'
import { useNow } from '../../deadline'
import { isSampleWorkspace } from '../../mock/sample-workspace'
import { useTendersStore } from '../../store'
import { CompanyFormDialog } from '../CompanyFormDialog'
import { Badge, Button, IconButton } from '../ui'

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
  // Deliberately not pinned to a time zone: `archivedAt` is a real instant (the
  // store stamps it with `new Date().toISOString()`), not a civil date someone
  // typed, so it is shown on the reader's own clock like every other instant the
  // app prints. Only user-entered civil dates are pinned to SAST.
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

            {/* deadline reminders */}
            <RemindersSection />

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
                  title="See what deleting this workspace would affect — Tenders offers archive instead"
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
                    Tenders has no permanent workspace delete, so this panel offers no delete
                    control. Archiving is the supported route — nothing is lost, and you can restore
                    the workspace at any time. Deleting “{company.tradingName || 'this workspace'}”
                    would remove every record it owns:
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
                    {archived ? (
                      <Button
                        variant="primary"
                        disabled={!activeCompanyId}
                        onClick={() => activeCompanyId && restoreCompany(activeCompanyId)}
                        title="Make this workspace active again"
                      >
                        <RotateCcw size={13} /> Restore workspace
                      </Button>
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

// ── deadline reminders ───────────────────────────────────────────────────────
//
// The settings surface for the only notification path this app has. The engines
// already existed — the pure schedule in `shared/reminders.ts` and the
// main-process scheduler behind the `tenders:reminders-*` channels — with no way
// for a user to see them, switch them off or retune the lead times.
//
// Two things this section must never do. It must not imply the app will stop a
// closing time being missed: a reminder is a nudge raised while the app is open,
// and the sentence that says so is not written here — it travels on
// `getReminders()` as `limitation` and is rendered verbatim, so the words the
// user reads are the words the scheduler logs. And it must not present a control
// whose effect it cannot confirm: a settings write that fails keeps the previous
// value on screen and shows the reason main gave, and no switch is offered at all
// until the settings have actually been read.

/** The shortest lead time this surface will send: the smallest unit it offers. */
const MIN_REMINDER_LEAD_MS = 3_600_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * The longest lead time is the IPC bound itself (`MAX_TENDERS_REMINDER_LEAD_MS`,
 * one year before closing) rather than a number typed into this file, so a value
 * this form accepts is never one main refuses. The shortest is an hour: the form
 * edits whole hours and days, so a five-second lead cannot be entered at all.
 * Main validates the same bounds and refuses the whole patch rather than dropping
 * a threshold silently, and the reason it gives is what the user is shown.
 */
const MAX_REMINDER_LEAD_DAYS = MAX_TENDERS_REMINDER_LEAD_MS / DAY_MS

/** One lead time as it is being edited. */
interface ReminderDraftRow {
  key: string
  amount: string
  unit: 'days' | 'hours'
}

/** "7 days" / "2 hours" — the label always names the lead time it is set to. */
function reminderLeadLabel(leadMs: number): string {
  if (leadMs % DAY_MS === 0) {
    const days = leadMs / DAY_MS
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (leadMs % HOUR_MS === 0) {
    const hours = leadMs / HOUR_MS
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const minutes = Math.round(leadMs / 60_000)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * The threshold to persist for a lead time. Ids live in the dedupe ledger and a
 * CHANGED id re-arms that reminder — which is exactly what a changed lead time
 * needs: a tender already warned at seven days must still be warned at five.
 * Reusing an id for a different lead would suppress that warning, so the id is
 * derived from the lead itself (a documented default keeps its documented id) and
 * is never carried over from a row the user edited.
 */
function reminderThresholdFor(leadMs: number): ReminderThreshold {
  const documented = DEFAULT_REMINDER_THRESHOLDS.find((threshold) => threshold.leadMs === leadMs)
  return { id: documented?.id ?? `lead-${leadMs}`, label: reminderLeadLabel(leadMs), leadMs }
}

function reminderLeadMs(row: ReminderDraftRow): number {
  const amount = Number(row.amount)
  if (!Number.isFinite(amount)) return NaN
  return amount * (row.unit === 'days' ? DAY_MS : HOUR_MS)
}

/** Days when the lead divides exactly, hours otherwise. */
function reminderLeadDraft(leadMs: number): { amount: string; unit: 'days' | 'hours' } {
  if (leadMs % DAY_MS === 0) return { amount: String(leadMs / DAY_MS), unit: 'days' }
  return { amount: String(Math.round(leadMs / HOUR_MS)), unit: 'hours' }
}

/**
 * The editor rows for a persisted list, longest lead first (the same display
 * order the pure core documents — which reminder fires is never decided by list
 * position). The list itself always comes from the settings shape, never from a
 * second copy of the default lead times kept here.
 */
function reminderRows(thresholds: ReminderThreshold[], nextKey: () => string): ReminderDraftRow[] {
  return [...thresholds]
    .sort((a, b) => b.leadMs - a.leadMs)
    .map((threshold) => ({ key: nextKey(), ...reminderLeadDraft(threshold.leadMs) }))
}

/** The lead time a row currently stands for, or "not set" while it is unusable. */
function reminderRowPreview(row: ReminderDraftRow): string {
  const leadMs = reminderLeadMs(row)
  return Number.isFinite(leadMs) && leadMs > 0 ? reminderLeadLabel(leadMs) : 'not set'
}

/** Why the lead times as typed cannot be saved, or null when they can. */
function reminderDraftProblem(rows: ReminderDraftRow[]): string | null {
  if (rows.length > MAX_TENDERS_REMINDER_THRESHOLDS) {
    return `At most ${MAX_TENDERS_REMINDER_THRESHOLDS} lead times can be set.`
  }
  const leads: number[] = []
  for (const row of rows) {
    const leadMs = reminderLeadMs(row)
    if (!Number.isInteger(Number(row.amount)) || leadMs < MIN_REMINDER_LEAD_MS) {
      return 'Every lead time is a whole number of days or hours, and at least one hour before closing.'
    }
    if (leadMs > MAX_TENDERS_REMINDER_LEAD_MS) {
      return `A lead time can be at most ${MAX_REMINDER_LEAD_DAYS} days before closing.`
    }
    if (leads.includes(leadMs)) {
      return `Two lead times are the same (${reminderLeadLabel(leadMs)}). A reminder is keyed by its lead time, so a duplicate would be dropped — change or remove one of them.`
    }
    leads.push(leadMs)
  }
  return null
}

function sameReminderThresholds(left: ReminderThreshold[], right: ReminderThreshold[]): boolean {
  if (left.length !== right.length) return false
  const keys = (thresholds: ReminderThreshold[]) =>
    thresholds.map((threshold) => `${threshold.id}\u0000${threshold.leadMs}`).sort()
  const a = keys(left)
  const b = keys(right)
  return a.every((value, index) => value === b[index])
}

/** The IPC bridge, when this build exposes it. */
function tendersBridge() {
  return typeof window === 'undefined' ? undefined : window.tendersApi
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * The reminder switch's own sizing.
 *
 * It carried this class while the shared `FORM_CHECKBOX_CLASS` measured 16x16:
 * that class was `size-4 box-content p-1`, and on a native checkbox `padding`
 * computes to `0px` (the user-agent stylesheet for the control owns it), so the
 * box stayed at 16px — a measured fact, not a guess: the e2e a11y journey
 * ("interactive targets below 24x24px") read the rendered border box and reported
 * this control at 16x16.
 *
 * The shared class has since been fixed to `size-6` and now measures
 * 23.93x23.93 (the same 24px box this one gives), so the two are equivalent
 * today. The switch keeps its own: its size is this surface's decision, and
 * `tests/reminders-settings-copy.test.ts` pins that it carries it.
 *
 * `size-6` is `calc(var(--spacing) * 6)` with the app's `--spacing: .25rem`:
 * exactly 24px on both axes, and since padding is ignored on a checkbox there is
 * nothing left for a box-sizing rule to reinterpret. The sidebar collapse control
 * in `App.tsx` is already a `size-6` button that passes this same measurement.
 */
const REMINDER_SWITCH_CLASS =
  'size-6 cursor-pointer rounded accent-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none'

function RemindersSection() {
  const workspaces = useTendersStore((s) => s.workspaces)
  // A live clock: "the next reminder is due in…" is a relative time, so it stays
  // true while the page sits open and cannot disagree with the schedule about
  // which instant it means.
  const now = useNow(60_000)

  const [busy, setBusy] = useState<'load' | 'save' | 'check' | null>('load')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settings, setSettings] = useState<ReminderSettings | null>(null)
  const [ledger, setLedger] = useState<ReminderLedger | null>(null)
  const [limitation, setLimitation] = useState<string | null>(null)
  const [rows, setRows] = useState<ReminderDraftRow[]>([])
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [checkResult, setCheckResult] = useState<{
    fired: number
    reminders: DueReminder[]
  } | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const rowKeys = useRef(0)

  const nextRowKey = () => `reminder-row-${(rowKeys.current += 1)}`

  const load = useCallback(async () => {
    const api = tendersBridge()
    setBusy('load')
    setLoadError(null)
    if (!api?.getReminders) {
      setLoadError('This build exposes no reminder settings to this page.')
      setBusy(null)
      return
    }
    try {
      const res = await api.getReminders()
      if (!res.ok) {
        setLoadError(res.error.message)
      } else {
        setSettings(res.settings)
        setLedger(res.ledger)
        setLimitation(res.limitation)
        setRows(
          reminderRows(res.settings.thresholds, () => `reminder-row-${(rowKeys.current += 1)}`),
        )
      }
    } catch (error: unknown) {
      setLoadError(errorMessage(error, 'The reminder settings could not be read.'))
    }
    setBusy(null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The master switch. Only `enabled` is written, so a half-edited lead time in
   * the list below is neither sent nor lost — and the switch only moves once main
   * says the write landed, so it never shows a setting the schedule does not have.
   */
  const setEnabled = async (enabled: boolean) => {
    const api = tendersBridge()
    setSettingsError(null)
    setSavedNotice(null)
    if (!api?.setReminders) {
      setSettingsError('This build exposes no way to save reminder settings, so nothing changed.')
      return
    }
    setBusy('save')
    try {
      const res = await api.setReminders({ enabled })
      if (!res.ok) {
        setSettingsError(res.error.message)
        return
      }
      setSettings((previous) =>
        previous ? { ...previous, enabled: res.settings.enabled } : res.settings,
      )
      setSavedNotice(enabled ? 'Reminders are on.' : 'Reminders are off.')
    } catch (error: unknown) {
      setSettingsError(errorMessage(error, 'The reminder settings could not be saved.'))
    } finally {
      setBusy(null)
    }
  }

  const saveThresholds = async () => {
    const problem = reminderDraftProblem(rows)
    if (problem) {
      setSettingsError(problem)
      return
    }
    const api = tendersBridge()
    setSettingsError(null)
    setSavedNotice(null)
    if (!api?.setReminders) {
      setSettingsError('This build exposes no way to save reminder settings, so nothing changed.')
      return
    }
    setBusy('save')
    try {
      const res = await api.setReminders({
        thresholds: rows.map((row) => reminderThresholdFor(reminderLeadMs(row))),
      })
      if (!res.ok) {
        setSettingsError(res.error.message)
        return
      }
      // The response is what was actually written, so the list shows the saved
      // schedule rather than the draft that was sent.
      setSettings(res.settings)
      setLimitation(res.limitation)
      setRows(reminderRows(res.settings.thresholds, () => `reminder-row-${(rowKeys.current += 1)}`))
      setSavedNotice(
        res.settings.thresholds.length === 0
          ? 'Saved. No lead times are set, so no reminder will fire even while reminders are on.'
          : 'Lead times saved.',
      )
    } catch (error: unknown) {
      setSettingsError(errorMessage(error, 'The reminder lead times could not be saved.'))
    } finally {
      setBusy(null)
    }
  }

  const runCheck = async () => {
    const api = tendersBridge()
    setCheckError(null)
    setCheckResult(null)
    if (!api?.checkReminders) {
      setCheckError('This build exposes no reminder check, so nothing was checked.')
      return
    }
    setBusy('check')
    try {
      const res = await api.checkReminders()
      if (!res.ok) {
        setCheckError(res.error.message)
        return
      }
      setCheckResult({ fired: res.fired, reminders: res.reminders })
      // A check records what it fired in the ledger, so re-read it: the "next
      // reminder" line must not keep describing a schedule that just moved.
      try {
        const state = await api.getReminders()
        if (state.ok) {
          setLedger(state.ledger)
          setLimitation(state.limitation)
        }
      } catch {
        // The check itself succeeded; the line above keeps the ledger it had and
        // claims nothing new about it.
      }
    } catch (error: unknown) {
      setCheckError(errorMessage(error, 'The reminder check could not be completed.'))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Every workspace, exactly as the schedule in main reads them: it walks the
   * whole authoritative store, not the open workspace, so a count taken from the
   * active workspace alone would understate what is being watched.
   */
  const watchedTenders = useMemo<ReminderTender[]>(() => {
    const all: ReminderTender[] = []
    for (const workspace of workspaces) {
      for (const tender of workspace.tenders) {
        all.push({
          id: tender.id,
          title: tender.title,
          closingDate: tender.closingDate,
          status: tender.status,
        })
      }
    }
    return all
  }, [workspaces])

  const openCount = useMemo(
    () =>
      watchedTenders.filter(
        (tender) =>
          isOpenTenderStatus(tender.status) &&
          (parseClosingDate(tender.closingDate)?.getTime() ?? 0) > now.getTime(),
      ).length,
    [watchedTenders, now],
  )

  const draftProblem = reminderDraftProblem(rows)
  const savedThresholds = settings?.thresholds ?? []
  const draftThresholds =
    draftProblem === null ? rows.map((row) => reminderThresholdFor(reminderLeadMs(row))) : null
  const dirty =
    settings === null ||
    draftThresholds === null ||
    !sameReminderThresholds(draftThresholds, savedThresholds)
  const missingDefaults = DEFAULT_REMINDER_THRESHOLDS.filter(
    (threshold) => !rows.some((row) => reminderLeadMs(row) === threshold.leadMs),
  )
  const nextDue = settings
    ? nextReminderAt(watchedTenders, settings, now, ledger ?? undefined)
    : null

  const nextDueLabel = !settings?.enabled
    ? 'No reminder is scheduled while reminders are off.'
    : savedThresholds.length === 0
      ? 'No reminder is scheduled: no lead times are set.'
      : nextDue
        ? `The next reminder is due in ${formatDeadlineDelta(nextDue.getTime() - now.getTime())}.`
        : 'No reminder is scheduled ahead of now — either no open tender has a closing time far enough ahead to reach a lead time, or every lead time for the tenders being watched has already been warned about.'

  const openTendersPhrase = `${openCount} open tender${openCount === 1 ? '' : 's'} with a closing time still ahead`
  const watchedLabel = !settings?.enabled
    ? `Reminders are off, so nothing is being watched: ${openTendersPhrase} would be watched if you switched this on.`
    : savedThresholds.length === 0
      ? `${openTendersPhrase} would be watched, but no lead times are set, so nothing can fire.`
      : `${openTendersPhrase} ${openCount === 1 ? 'is' : 'are'} being watched.`

  const updateRow = (key: string, patch: Partial<ReminderDraftRow>) => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setSavedNotice(null)
  }

  const removeRow = (key: string) => {
    setRows((previous) => previous.filter((row) => row.key !== key))
    setSavedNotice(null)
  }

  const addThreshold = (leadMs: number) => {
    setRows((previous) => [...previous, { key: nextRowKey(), ...reminderLeadDraft(leadMs) }])
    setSavedNotice(null)
  }

  const changeUnit = (row: ReminderDraftRow, unit: 'days' | 'hours'): Partial<ReminderDraftRow> => {
    const amount = Number(row.amount)
    if (row.unit === unit) return {}
    if (!Number.isFinite(amount) || amount <= 0) return { unit }
    // The number is converted so the lead time it stands for does not silently
    // change meaning under a new unit. Hours that are not whole days round to the
    // nearest day, which the user sees in the field immediately.
    if (unit === 'hours') return { unit, amount: String(Math.round(amount * 24)) }
    return { unit, amount: String(Math.max(1, Math.round(amount / 24))) }
  }

  return (
    <section
      data-testid="reminders-section"
      aria-labelledby="reminders-heading"
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          id="reminders-heading"
          className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]"
        >
          <Bell size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
          Deadline reminders
        </h2>
        {settings && (
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="reminders-status">
              <Badge tone={settings.enabled ? 'green' : 'slate'}>
                {settings.enabled ? 'On' : 'Off'}
              </Badge>
            </span>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                data-testid="reminders-enabled-toggle"
                checked={settings.enabled}
                disabled={busy !== null}
                onChange={(event) => void setEnabled(event.target.checked)}
                className={REMINDER_SWITCH_CLASS}
              />
              <span className="text-[12px] text-[var(--text-secondary)]">
                {settings.enabled ? 'Reminders are on' : 'Reminders are off'}
              </span>
            </label>
          </div>
        )}
      </div>

      {busy === 'load' && !settings && (
        <p className="text-[12px] text-[var(--text-tertiary)]">Reading the reminder settings…</p>
      )}

      {loadError && (
        <div
          data-testid="reminders-unavailable"
          className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2.5"
        >
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--danger-text)]">
            <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {loadError} This section shows no switch until the reminder settings can be read — a
              switch that never reached the schedule would say something untrue about what is on.
            </span>
          </p>
          <Button
            variant="default"
            size="sm"
            className="mt-2"
            data-testid="reminders-retry"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {settingsError && (
        <p
          role="alert"
          data-testid="reminders-save-error"
          className="mb-3 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] font-medium text-[var(--danger-text)]"
        >
          <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{settingsError}</span>
        </p>
      )}

      {savedNotice && (
        <p
          role="status"
          data-testid="reminders-saved"
          className="mb-3 text-[11px] font-medium text-[var(--color-brand-secondary)]"
        >
          {savedNotice}
        </p>
      )}

      {limitation && (
        <div className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text)]">
            <ShieldAlert size={12} className="shrink-0 text-[var(--warn)]" aria-hidden="true" />
            What a reminder can and cannot reach
          </p>
          <p
            data-testid="reminders-limitation"
            className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]"
          >
            {limitation}
          </p>
        </div>
      )}

      <p
        data-testid="reminders-notification-reach"
        className="mt-3 text-[11px] leading-relaxed text-[var(--text-tertiary)]"
      >
        A due reminder is raised as a desktop notification by this app, on this machine — that is
        the only channel it uses, and nothing is sent to anyone else. If this system does not
        support desktop notifications, a reminder that falls due cannot be shown: the app reports
        that in its reminder log, still records the reminder so it cannot fire twice, and the limit
        above is unchanged.
      </p>

      {settings && (
        <div className="mt-3 space-y-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          <p data-testid="reminders-watched-count">{watchedLabel}</p>
          <p data-testid="reminders-next-due">{nextDueLabel}</p>
        </div>
      )}

      {settings && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-semibold text-[var(--text)]">Lead times</h3>
            {dirty && (
              <span data-testid="reminders-draft-hint" className="text-[11px] text-[var(--warn)]">
                Unsaved changes — the schedule above still uses the saved lead times.
              </span>
            )}
          </div>

          <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            Every lead time in this list is one that will fire; removing one switches that lead time
            off, and the documented lead times below can be added back at any time.
          </p>

          <ul className="space-y-2">
            {rows.map((row, index) => (
              <li
                key={row.key}
                data-testid="reminders-threshold-row"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2"
              >
                <input
                  type="number"
                  data-testid="reminders-threshold-amount"
                  aria-label={`Lead time ${index + 1}: amount before closing`}
                  value={row.amount}
                  min={1}
                  max={row.unit === 'days' ? MAX_REMINDER_LEAD_DAYS : MAX_REMINDER_LEAD_DAYS * 24}
                  step={1}
                  disabled={busy !== null}
                  onChange={(event) => updateRow(row.key, { amount: event.target.value })}
                  className="w-16 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[13px] text-[var(--text)] outline-none focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]"
                />
                <select
                  data-testid="reminders-threshold-unit"
                  aria-label={`Lead time ${index + 1}: unit`}
                  value={row.unit}
                  disabled={busy !== null}
                  onChange={(event) =>
                    updateRow(row.key, changeUnit(row, event.target.value as 'days' | 'hours'))
                  }
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[13px] text-[var(--text)] outline-none focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]"
                >
                  <option value="days">days</option>
                  <option value="hours">hours</option>
                </select>
                <span className="text-[11px] text-[var(--text-tertiary)]">before closing</span>
                <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                  {reminderRowPreview(row)}
                </span>
                <IconButton
                  label={`Remove the ${reminderRowPreview(row)} lead time`}
                  data-testid="reminders-threshold-remove"
                  disabled={busy !== null}
                  onClick={() => removeRow(row.key)}
                >
                  <X size={13} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>

          {rows.length === 0 && (
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              No lead times are set, so no reminder will fire even while reminders are on.
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--text-tertiary)]">Add:</span>
            {missingDefaults.map((threshold) => (
              <button
                key={threshold.id}
                type="button"
                data-testid={`reminders-add-${threshold.id}`}
                disabled={busy !== null}
                onClick={() => addThreshold(threshold.leadMs)}
                className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={11} aria-hidden="true" /> {threshold.label}
              </button>
            ))}
            <button
              type="button"
              data-testid="reminders-add-custom"
              disabled={busy !== null}
              onClick={() => addThreshold(HOUR_MS)}
              className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={11} aria-hidden="true" /> another lead time
            </button>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            Whole days or hours — at least 1 hour and at most {MAX_REMINDER_LEAD_DAYS} days before
            closing. A changed lead time is a new reminder: a tender already warned at one lead time
            is warned again at the new one, because the closing time it is being warned about has
            not changed.
          </p>

          {draftProblem && (
            <p
              role="alert"
              data-testid="reminders-draft-problem"
              className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]"
            >
              <ShieldAlert
                size={12}
                className="mt-0.5 shrink-0 text-[var(--warn)]"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">{draftProblem}</span>
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="reminders-save-thresholds"
              disabled={busy !== null || !dirty || draftProblem !== null}
              onClick={() => void saveThresholds()}
            >
              Save lead times
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="reminders-discard-thresholds"
              disabled={busy !== null || !dirty}
              onClick={() => {
                if (!settings) return
                setRows(reminderRows(settings.thresholds, nextRowKey))
                setSettingsError(null)
                setSavedNotice(null)
              }}
            >
              Discard changes
            </Button>
          </div>
        </div>
      )}

      {settings && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              data-testid="reminders-check-now"
              disabled={busy !== null}
              onClick={() => void runCheck()}
            >
              <RefreshCw size={13} aria-hidden="true" /> Check for due reminders now
            </Button>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              Runs one check straight away. Tenders also checks on its own while it is running.
            </span>
          </div>

          {checkError && (
            <p
              role="alert"
              data-testid="reminders-check-error"
              className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11px] font-medium text-[var(--danger-text)]"
            >
              <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{checkError}</span>
            </p>
          )}

          {checkResult && (
            <div
              data-testid="reminders-check-result"
              className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2"
            >
              <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {checkResult.fired > 0
                  ? `${checkResult.fired} deadline reminder${checkResult.fired === 1 ? '' : 's'} ${checkResult.fired === 1 ? 'was' : 'were'} due just now. Each one names the tender, the time left and the closing instant:`
                  : settings.enabled === false
                    ? 'The check ran, but reminders are switched off, so nothing could fire.'
                    : savedThresholds.length === 0
                      ? 'The check ran, but no lead times are set, so nothing could fire.'
                      : 'The check ran and no reminder was due just now.'}
              </p>
              {checkResult.reminders.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {checkResult.reminders.map((reminder) => (
                    <li key={`${reminder.tenderId}-${reminder.thresholdId}-${reminder.closingAt}`}>
                      {describeReminder(reminder)}
                      {reminder.late &&
                        ' This warning is late — the moment it was due had already passed when this check ran.'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

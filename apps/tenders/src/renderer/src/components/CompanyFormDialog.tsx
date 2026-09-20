// Company create / edit dialog — Phase 4, WP-8.
//
// One form for both first-run setup and later profile edits, so every field the
// bid pack needs is reachable: identity, registration/compliance numbers,
// contact details, capability text, directors and project track record.
//
// The dialog is presentational: the caller decides what to do with the profile
// (`addCompany` for a new workspace, `updateActiveCompany` for an edit).
import { useState } from 'react'
import { Building2, Plus, Trash2 } from 'lucide-react'
import type { CompanyProfile, ProjectStatus } from '../../../shared/types'
import { Dialog } from './Dialog'
import { Button, FormField, FormSelect } from './ui'

type Mode = 'create' | 'edit'

export interface CompanyFormDialogProps {
  mode: Mode
  /** Existing profile when editing (ignored when creating). */
  initial?: CompanyProfile
  onClose: () => void
  onSubmit: (profile: CompanyProfile) => void
}

const EMPTY_PROFILE: CompanyProfile = {
  name: '',
  tradingName: '',
  registrationNumber: '',
  vatNumber: '',
  taxPin: '',
  bbbeeLevel: '',
  bbbeeBlackOwnership: '',
  csdSupplierNumber: '',
  founded: '',
  employees: '',
  industry: '',
  description: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  directors: [],
  projects: [],
}

const PROJECT_STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'BIDDING', label: 'Bidding' },
  { value: 'ON_HOLD', label: 'On hold' },
]

let projectSeq = 0
const newProjectId = (): string => `p-${Date.now()}-${projectSeq++}`

export function CompanyFormDialog({ mode, initial, onClose, onSubmit }: CompanyFormDialogProps) {
  const [draft, setDraft] = useState<CompanyProfile>(() => ({
    ...EMPTY_PROFILE,
    ...(initial ?? {}),
    directors: (initial?.directors ?? []).map((d) => ({ ...d })),
    projects: (initial?.projects ?? []).map((p) => ({ ...p })),
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const set = (key: keyof CompanyProfile) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const setDirector = (index: number, key: 'name' | 'role' | 'idNumber', value: string) =>
    setDraft((current) => ({
      ...current,
      directors: current.directors.map((d, i) => (i === index ? { ...d, [key]: value } : d)),
    }))

  const setProject = <K extends keyof CompanyProfile['projects'][number]>(
    index: number,
    key: K,
    value: CompanyProfile['projects'][number][K],
  ) =>
    setDraft((current) => ({
      ...current,
      projects: current.projects.map((p, i) => (i === index ? { ...p, [key]: value } : p)),
    }))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const tradingName = draft.tradingName.trim()
    if (!tradingName) nextErrors.tradingName = 'A trading name is required.'
    const email = draft.email.trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.email = 'That does not look like an e-mail address.'
    }
    draft.projects.forEach((project, index) => {
      if (!project.title.trim()) nextErrors[`project-${index}`] = 'Give the project a title.'
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    onSubmit({
      ...draft,
      name: draft.name.trim() || tradingName,
      tradingName,
      registrationNumber: draft.registrationNumber.trim(),
      vatNumber: draft.vatNumber.trim(),
      taxPin: draft.taxPin.trim(),
      bbbeeLevel: draft.bbbeeLevel.trim(),
      bbbeeBlackOwnership: draft.bbbeeBlackOwnership.trim(),
      csdSupplierNumber: draft.csdSupplierNumber.trim(),
      founded: draft.founded.trim(),
      employees: draft.employees.trim(),
      industry: draft.industry.trim(),
      description: draft.description.trim(),
      address: draft.address.trim(),
      phone: draft.phone.trim(),
      email,
      website: draft.website.trim(),
      directors: draft.directors
        .map((d) => ({ name: d.name.trim(), role: d.role.trim(), idNumber: d.idNumber.trim() }))
        .filter((d) => d.name || d.role || d.idNumber),
      projects: draft.projects.map((p) => ({
        ...p,
        title: p.title.trim(),
        client: p.client.trim(),
        value: p.value.trim(),
        period: p.period.trim(),
        sector: p.sector.trim(),
        description: p.description.trim(),
      })),
    })
  }

  const isCreate = mode === 'create'

  return (
    <Dialog
      title={isCreate ? 'Set up your company' : 'Edit company profile'}
      subtitle={
        isCreate
          ? 'These details fill your bid documents. Only the trading name is required — everything else can be added later.'
          : 'Changes are saved on this machine and used by bid readiness and gap analysis.'
      }
      icon={<Building2 size={16} className="text-[var(--accent)]" aria-hidden="true" />}
      closeLabel="Close company form"
      onClose={onClose}
      size="xl"
      bodyClassName="min-h-0"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scroll-thin px-5 py-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Identity</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Trading name"
                required
                autoFocus
                value={draft.tradingName}
                onChange={set('tradingName')}
                placeholder="e.g. Lephalale Civils (Pty) Ltd"
                error={errors.tradingName ?? null}
              />
              <FormField
                label="Registered name"
                value={draft.name}
                onChange={set('name')}
                placeholder="Defaults to the trading name"
              />
              <FormField
                label="Industry / sector"
                value={draft.industry}
                onChange={set('industry')}
                placeholder="e.g. Civil construction"
              />
              <FormField
                label="Year founded"
                value={draft.founded}
                onChange={set('founded')}
                placeholder="e.g. 2014"
              />
              <FormField
                label="Employees"
                value={draft.employees}
                onChange={set('employees')}
                placeholder="e.g. 42"
              />
              <FormField
                label="Website"
                value={draft.website}
                onChange={set('website')}
                placeholder="e.g. www.example.co.za"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">
              Registration &amp; compliance
            </legend>
            <p className="text-[11px] text-[var(--text-tertiary)]">
              Tenders asks for these on most returnable forms. Leave a field blank if you do not
              have it yet — readiness will flag it when a tender demands it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="CIPC registration number"
                value={draft.registrationNumber}
                onChange={set('registrationNumber')}
                placeholder="e.g. 2016/123456/07"
              />
              <FormField
                label="VAT number"
                value={draft.vatNumber}
                onChange={set('vatNumber')}
                placeholder="e.g. 4820315678"
              />
              <FormField
                label="SARS tax / TCS PIN"
                value={draft.taxPin}
                onChange={set('taxPin')}
                placeholder="e.g. 0123456789"
              />
              <FormField
                label="CSD supplier number"
                value={draft.csdSupplierNumber}
                onChange={set('csdSupplierNumber')}
                placeholder="e.g. MAZE-4451902"
              />
              <FormField
                label="B-BBEE level"
                value={draft.bbbeeLevel}
                onChange={set('bbbeeLevel')}
                placeholder="e.g. Level 1 (EME)"
              />
              <FormField
                label="Black ownership"
                value={draft.bbbeeBlackOwnership}
                onChange={set('bbbeeBlackOwnership')}
                placeholder="e.g. 100%"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Contact</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Phone"
                value={draft.phone}
                onChange={set('phone')}
                placeholder="e.g. 015 783 0022"
              />
              <FormField
                label="E-mail"
                type="email"
                value={draft.email}
                onChange={set('email')}
                placeholder="e.g. tenders@example.co.za"
                error={errors.email ?? null}
              />
              <FormField
                label="Physical / postal address"
                value={draft.address}
                onChange={set('address')}
                placeholder="e.g. 12 Industrial Rd, Polokwane"
                className="sm:col-span-2"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">
              Capability statement
            </legend>
            <FormField
              label="What the company does"
              textarea
              rows={4}
              value={draft.description}
              onChange={set('description')}
              placeholder="Plain description of the services, sectors and capacity the company can deliver."
              hint="Used in the profile summary; Tenders never writes marketing copy for you."
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">
              Directors / members
            </legend>
            {draft.directors.length === 0 && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                No directors recorded yet. Most returnable forms need the people who may sign for
                the company.
              </p>
            )}
            <ul className="space-y-2">
              {draft.directors.map((director, index) => (
                <li
                  key={index}
                  className="grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <FormField
                    label="Name"
                    value={director.name}
                    onChange={(value) => setDirector(index, 'name', value)}
                    placeholder="e.g. Thabo Mokoena"
                  />
                  <FormField
                    label="Role"
                    value={director.role}
                    onChange={(value) => setDirector(index, 'role', value)}
                    placeholder="e.g. Managing Director"
                  />
                  <FormField
                    label="ID / passport number"
                    value={director.idNumber}
                    onChange={(value) => setDirector(index, 'idNumber', value)}
                    placeholder="Optional"
                  />
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      variant="danger"
                      title="Remove this director"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          directors: current.directors.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      <Trash2 size={12} /> Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="default"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  directors: [...current.directors, { name: '', role: '', idNumber: '' }],
                }))
              }
            >
              <Plus size={13} /> Add director
            </Button>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">
              Project track record
            </legend>
            {draft.projects.length === 0 && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                No projects recorded yet. Similar-project references are one of the most commonly
                requested returnables.
              </p>
            )}
            <ul className="space-y-2">
              {draft.projects.map((project, index) => (
                <li
                  key={project.id}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[11px] font-semibold text-[var(--text-secondary)]">
                      Project {index + 1}
                      {project.title ? ` — ${project.title}` : ''}
                    </p>
                    <Button
                      size="sm"
                      variant="danger"
                      title="Remove this project"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          projects: current.projects.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      <Trash2 size={12} /> Remove
                    </Button>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <FormField
                      label="Title"
                      value={project.title}
                      onChange={(value) => setProject(index, 'title', value)}
                      placeholder="e.g. Vaal River Road Rehabilitation — Phase 2"
                      error={errors[`project-${index}`] ?? null}
                    />
                    <FormField
                      label="Client"
                      value={project.client}
                      onChange={(value) => setProject(index, 'client', value)}
                      placeholder="e.g. Department of Water and Sanitation"
                    />
                    <FormField
                      label="Value"
                      value={project.value}
                      onChange={(value) => setProject(index, 'value', value)}
                      placeholder="e.g. R 18.4 million"
                    />
                    <FormField
                      label="Period"
                      value={project.period}
                      onChange={(value) => setProject(index, 'period', value)}
                      placeholder="e.g. 2023–2024"
                    />
                    <FormSelect
                      label="Status"
                      value={project.status}
                      onChange={(value) => setProject(index, 'status', value as ProjectStatus)}
                      options={PROJECT_STATUS_OPTIONS}
                    />
                    <FormField
                      label="Sector"
                      value={project.sector}
                      onChange={(value) => setProject(index, 'sector', value)}
                      placeholder="e.g. Civil"
                    />
                    <FormField
                      label="Description"
                      textarea
                      rows={2}
                      value={project.description}
                      onChange={(value) => setProject(index, 'description', value)}
                      className="sm:col-span-2"
                    />
                  </div>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="default"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  projects: [
                    ...current.projects,
                    {
                      id: newProjectId(),
                      title: '',
                      client: '',
                      value: '',
                      period: '',
                      status: 'COMPLETED',
                      description: '',
                      sector: '',
                    },
                  ],
                }))
              }
            >
              <Plus size={13} /> Add project
            </Button>
          </fieldset>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            {isCreate ? 'Create workspace' : 'Save changes'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}

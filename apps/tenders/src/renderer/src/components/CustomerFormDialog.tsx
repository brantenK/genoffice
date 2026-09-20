// Customer create / edit dialog — Phase 4, WP-8.
//
// Customers are deliberately tender-focused: identity, the contact person for
// clarifications, and the documents this client expects in a bid pack. There are
// no activities, pipelines, campaigns or enrichment fields.
//
// Presentational: the caller wires the store (`addCustomer` / `updateCustomer`).
import { useState } from 'react'
import { Plus, Trash2, UserPlus } from 'lucide-react'
import {
  DOC_CATEGORY_LABEL,
  type Customer,
  type CustomerStatus,
  type DocCategory,
  type VaultDoc,
} from '../../../shared/types'
import { Dialog } from './Dialog'
import {
  Button,
  FORM_CHECKBOX_CLASS,
  FORM_CONTROL_CLASS,
  FORM_LABEL_CLASS,
  FormField,
  FormSelect,
} from './ui'

type Mode = 'create' | 'edit'

export interface CustomerFormDialogProps {
  mode: Mode
  /** Existing customer when editing (ignored when creating). */
  initial?: Customer
  /** Active workspace vault, used to link required documents. */
  vault: VaultDoc[]
  onClose: () => void
  onSubmit: (customer: Customer) => void
}

const STATUS_OPTIONS: { value: CustomerStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'INACTIVE', label: 'Inactive' },
]

const DOC_CATEGORY_OPTIONS = (Object.keys(DOC_CATEGORY_LABEL) as DocCategory[]).map((value) => ({
  value,
  label: DOC_CATEGORY_LABEL[value],
}))

let customerSeq = 0
const today = (): string => new Date().toISOString().slice(0, 10)

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export function CustomerFormDialog({
  mode,
  initial,
  vault,
  onClose,
  onSubmit,
}: CustomerFormDialogProps) {
  const [draft, setDraft] = useState<Customer>(() => ({
    id: initial?.id ?? `c-${Date.now()}-${customerSeq++}`,
    name: initial?.name ?? '',
    contactName: initial?.contactName ?? '',
    contactEmail: initial?.contactEmail ?? '',
    contactPhone: initial?.contactPhone ?? '',
    industry: initial?.industry ?? '',
    status: initial?.status ?? 'ACTIVE',
    since: initial?.since ?? today(),
    notes: initial?.notes ?? '',
    requiredDocs: (initial?.requiredDocs ?? []).map((doc) => ({ ...doc })),
    // Editing must never silently restore an archived customer.
    archivedAt: initial?.archivedAt ?? null,
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const set = (key: keyof Customer) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const setRequiredDoc = <K extends keyof Customer['requiredDocs'][number]>(
    index: number,
    key: K,
    value: Customer['requiredDocs'][number][K],
  ) =>
    setDraft((current) => ({
      ...current,
      requiredDocs: current.requiredDocs.map((doc, i) =>
        i === index ? { ...doc, [key]: value } : doc,
      ),
    }))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const name = draft.name.trim()
    if (!name) nextErrors.name = 'A customer name is required.'
    if (!isCivilDate(draft.since)) nextErrors.since = 'Use a date in the form YYYY-MM-DD.'
    const email = draft.contactEmail.trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.contactEmail = 'That does not look like an e-mail address.'
    }
    draft.requiredDocs.forEach((doc, index) => {
      if (!doc.label.trim()) nextErrors[`doc-${index}`] = 'Describe the document.'
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    onSubmit({
      ...draft,
      name,
      contactName: draft.contactName.trim(),
      contactEmail: email,
      contactPhone: draft.contactPhone.trim(),
      industry: draft.industry.trim(),
      notes: draft.notes.trim(),
      requiredDocs: draft.requiredDocs.map((doc) => ({
        docCategory: doc.docCategory,
        label: doc.label.trim(),
        fulfilled: doc.fulfilled,
        linkedVaultDocId: doc.linkedVaultDocId,
      })),
      archivedAt: draft.archivedAt ?? null,
    })
  }

  const isCreate = mode === 'create'

  return (
    <Dialog
      title={isCreate ? 'Add a customer' : 'Edit customer'}
      subtitle="Who the tender is for, who to contact, and the documents they expect in a bid pack."
      icon={<UserPlus size={16} className="text-[var(--accent)]" aria-hidden="true" />}
      closeLabel="Close customer form"
      onClose={onClose}
      size="xl"
      bodyClassName="min-h-0"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scroll-thin px-5 py-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Customer</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Customer name"
                required
                autoFocus
                value={draft.name}
                onChange={set('name')}
                placeholder="e.g. Lephalale Local Municipality"
                error={errors.name ?? null}
                className="sm:col-span-2"
              />
              <FormField
                label="Industry / sector"
                value={draft.industry}
                onChange={set('industry')}
                placeholder="e.g. Local government"
              />
              <FormSelect
                label="Status"
                value={draft.status}
                onChange={(value) => set('status')(value)}
                options={STATUS_OPTIONS}
              />
              <FormField
                label="Working with them since"
                type="date"
                value={draft.since}
                onChange={set('since')}
                error={errors.since ?? null}
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">
              Clarifications contact
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Name"
                value={draft.contactName}
                onChange={set('contactName')}
                placeholder="e.g. Dineo Lethabo"
              />
              <FormField
                label="E-mail"
                type="email"
                value={draft.contactEmail}
                onChange={set('contactEmail')}
                placeholder="e.g. scm@example.gov.za"
                error={errors.contactEmail ?? null}
              />
              <FormField
                label="Phone"
                value={draft.contactPhone}
                onChange={set('contactPhone')}
                placeholder="e.g. +27 11 834 0012"
                className="sm:col-span-2"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Required documents</legend>
            <p className="text-[11px] text-[var(--text-tertiary)]">
              What this customer expects in a bid pack. Link a vault document to mark it as ready;
              anything unlinked stays on the outstanding list.
            </p>
            {draft.requiredDocs.length === 0 && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                No document requirements defined yet.
              </p>
            )}
            <ul className="space-y-2">
              {draft.requiredDocs.map((doc, index) => (
                <li
                  key={index}
                  className="grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-3 sm:grid-cols-[1fr_1.4fr_1.2fr_auto]"
                >
                  <FormSelect
                    label="Category"
                    value={doc.docCategory}
                    onChange={(value) => setRequiredDoc(index, 'docCategory', value as DocCategory)}
                    options={DOC_CATEGORY_OPTIONS}
                  />
                  <FormField
                    label="Document"
                    value={doc.label}
                    onChange={(value) => setRequiredDoc(index, 'label', value)}
                    placeholder="e.g. SARS Tax Clearance"
                    error={errors[`doc-${index}`] ?? null}
                  />
                  <div>
                    <label className={FORM_LABEL_CLASS} htmlFor={`cust-doc-${index}`}>
                      Vault document
                    </label>
                    <select
                      id={`cust-doc-${index}`}
                      value={doc.linkedVaultDocId ?? ''}
                      onChange={(event) => {
                        const linkedVaultDocId = event.target.value || null
                        setRequiredDoc(index, 'linkedVaultDocId', linkedVaultDocId)
                        setRequiredDoc(index, 'fulfilled', Boolean(linkedVaultDocId))
                      }}
                      className={FORM_CONTROL_CLASS}
                    >
                      <option value="">— none linked —</option>
                      {vault.map((vaultDoc) => (
                        <option key={vaultDoc.id} value={vaultDoc.id}>
                          {vaultDoc.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <label className="mb-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                      <input
                        type="checkbox"
                        checked={doc.fulfilled}
                        onChange={(event) =>
                          setRequiredDoc(index, 'fulfilled', event.target.checked)
                        }
                        className={FORM_CHECKBOX_CLASS}
                      />
                      Ready
                    </label>
                    <Button
                      size="sm"
                      variant="danger"
                      title="Remove this document requirement"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          requiredDocs: current.requiredDocs.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      <Trash2 size={12} />
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
                  requiredDocs: [
                    ...current.requiredDocs,
                    {
                      docCategory: 'COMPLIANCE',
                      label: '',
                      fulfilled: false,
                      linkedVaultDocId: null,
                    },
                  ],
                }))
              }
            >
              <Plus size={13} /> Add document requirement
            </Button>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Notes</legend>
            <FormField
              label="Anything worth remembering about this customer"
              textarea
              rows={3}
              value={draft.notes}
              onChange={set('notes')}
              placeholder="e.g. Annual compliance pack renewal each March."
            />
          </fieldset>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            {isCreate ? 'Add customer' : 'Save changes'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}

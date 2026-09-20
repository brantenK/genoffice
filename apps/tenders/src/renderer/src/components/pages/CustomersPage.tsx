// Customers — create, view, edit and archive the clients/buyers the company bids
// to, plus the document requirements each one expects in a bid pack
// (Phase 4, WP-8).
//
// Deliberately tender-focused: no activities, pipelines, campaigns or enrichment.
// Customer lifecycle is soft-archive only; the destructive path is shown but
// disabled until managed-file/trash semantics exist.
import { useState } from 'react'
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Mail,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Trash2,
  User,
  UserPlus,
  XCircle,
} from 'lucide-react'
import type { Customer, CustomerStatus, DocCategory } from '../../../shared/types'
import { useTendersStore } from '../../store'
import { CustomerFormDialog } from '../CustomerFormDialog'
import { Badge, Button } from '../ui'

const STATUS_TONE: Record<CustomerStatus, 'green' | 'sky' | 'slate'> = {
  ACTIVE: 'green',
  PROSPECT: 'sky',
  INACTIVE: 'slate',
}

const STATUS_LABEL: Record<CustomerStatus, string> = {
  ACTIVE: 'Active',
  PROSPECT: 'Prospect',
  INACTIVE: 'Inactive',
}

// Category labels are small chrome text, so each tone must clear 4.5:1 on the
// card surface. `text-[var(--accent-dark)]` is the app accent at 7.7:1; the
// remaining tones are the 600/700 palette steps measured at ≥4.5:1 on white.
const DOC_CAT_COLOR: Record<DocCategory, string> = {
  COMPLIANCE: 'text-[var(--accent-dark)]',
  FINANCIAL: 'text-emerald-700',
  TECHNICAL: 'text-sky-700',
  GOVERNANCE: 'text-violet-700',
  CV: 'text-amber-700',
}

type CustomerFilter = CustomerStatus | 'ALL' | 'ARCHIVED'

export function CustomersPage() {
  const customers = useTendersStore((s) => s.customers)
  const vault = useTendersStore((s) => s.vault)
  const addCustomer = useTendersStore((s) => s.addCustomer)
  const updateCustomer = useTendersStore((s) => s.updateCustomer)
  const archiveCustomer = useTendersStore((s) => s.archiveCustomer)
  const restoreCustomer = useTendersStore((s) => s.restoreCustomer)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<CustomerFilter>('ALL')
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null)

  const activeCustomers = customers.filter((customer) => !customer.archivedAt)
  const archivedCustomers = customers.filter((customer) => customer.archivedAt)
  const selected = customers.find((customer) => customer.id === selectedId) ?? null

  const shown =
    filter === 'ARCHIVED'
      ? archivedCustomers
      : filter === 'ALL'
        ? activeCustomers
        : activeCustomers.filter((customer) => customer.status === filter)

  if (selected) {
    return (
      <CustomerDetail
        customer={selected}
        vault={vault}
        onBack={() => setSelectedId(null)}
        onEdit={() => setFormMode('edit')}
        onArchive={() => archiveCustomer(selected.id)}
        onRestore={() => restoreCustomer(selected.id)}
        editDialog={
          formMode === 'edit' ? (
            <CustomerFormDialog
              mode="edit"
              initial={selected}
              vault={vault}
              onClose={() => setFormMode(null)}
              onSubmit={(next) => {
                updateCustomer(selected.id, next)
                setFormMode(null)
              }}
            />
          ) : null
        }
      />
    )
  }

  const filters: { key: CustomerFilter; label: string; count: number }[] = [
    { key: 'ALL', label: 'All', count: activeCustomers.length },
    {
      key: 'ACTIVE',
      label: 'Active',
      count: activeCustomers.filter((c) => c.status === 'ACTIVE').length,
    },
    {
      key: 'PROSPECT',
      label: 'Prospect',
      count: activeCustomers.filter((c) => c.status === 'PROSPECT').length,
    },
    {
      key: 'INACTIVE',
      label: 'Inactive',
      count: activeCustomers.filter((c) => c.status === 'INACTIVE').length,
    },
    ...(archivedCustomers.length > 0
      ? [{ key: 'ARCHIVED' as CustomerFilter, label: 'Archived', count: archivedCustomers.length }]
      : []),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Customers</h1>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              The clients and buyers you bid to, with the documents each one expects in a bid pack.
            </p>
          </div>
          <Button variant="primary" onClick={() => setFormMode('create')}>
            <UserPlus size={15} /> Add customer
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        {customers.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            {filters.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setFilter(entry.key)}
                aria-pressed={filter === entry.key}
                className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none ${
                  filter === entry.key
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                    : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                }`}
              >
                {entry.label} ({entry.count})
              </button>
            ))}
          </div>
        )}

        {customers.length === 0 ? (
          <EmptyCustomers onAdd={() => setFormMode('create')} />
        ) : (
          <>
            {/* customer cards grid */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((customer) => {
                const fulfilled = customer.requiredDocs.filter((doc) => doc.fulfilled).length
                const total = customer.requiredDocs.length
                const pct = total > 0 ? Math.round((fulfilled / total) * 100) : 0
                const issues = customer.requiredDocs.filter((doc) => !doc.fulfilled).length
                const archived = Boolean(customer.archivedAt)
                return (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => setSelectedId(customer.id)}
                    className={`group cursor-pointer rounded-xl border bg-[var(--surface)] p-5 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none ${
                      archived ? 'border-[var(--border)] opacity-80' : 'border-[var(--border)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--text)] group-hover:text-[var(--accent-dark)]">
                          {customer.name}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                          {customer.industry || 'Sector not stated'}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={STATUS_TONE[customer.status]}>
                          {STATUS_LABEL[customer.status]}
                        </Badge>
                        {archived && <Badge tone="amber">Archived</Badge>}
                      </div>
                    </div>

                    {/* progress bar */}
                    <div className="mt-4">
                      <div className="mb-1.5 flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
                        <span>
                          {fulfilled}/{total} docs ready
                        </span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
                        <div
                          className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : issues > 0 ? 'bg-amber-400' : 'bg-indigo-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-[11px] text-[var(--text-tertiary)]">
                        Since {customer.since}
                      </p>
                      {issues > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--warn)]">
                          <XCircle size={11} aria-hidden="true" /> {issues} missing
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent-dark)]">
                          <CheckCircle2 size={11} aria-hidden="true" />{' '}
                          {total > 0 ? 'All documents ready' : 'No documents defined'}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            {shown.length === 0 && (
              <p className="py-10 text-center text-sm text-[var(--text-tertiary)]">
                {filter === 'ARCHIVED'
                  ? 'No archived customers.'
                  : activeCustomers.length === 0
                    ? 'Every customer is archived.'
                    : 'No customers match this filter.'}
              </p>
            )}
          </>
        )}
      </div>

      {formMode === 'create' && (
        <CustomerFormDialog
          mode="create"
          vault={vault}
          onClose={() => setFormMode(null)}
          onSubmit={(customer) => {
            addCustomer(customer)
            setSelectedId(customer.id)
            setFormMode(null)
          }}
        />
      )}
    </div>
  )
}

function EmptyCustomers({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-dark)]">
        <UserPlus size={22} aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-sm font-semibold text-[var(--text)]">No customers yet</h2>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--text-secondary)]">
        Add the clients and buyers you bid to. For each one you can list the documents they expect
        in a bid pack, then link the matching vault documents when they are ready.
      </p>
      <Button variant="primary" className="mt-4" onClick={onAdd}>
        <Plus size={14} /> Add your first customer
      </Button>
    </div>
  )
}

function CustomerDetail({
  customer,
  vault,
  onBack,
  onEdit,
  onArchive,
  onRestore,
  editDialog,
}: {
  customer: Customer
  vault: { id: string; title: string; expiryDate: string | null }[]
  onBack: () => void
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  editDialog: React.ReactNode
}) {
  const [removeOpen, setRemoveOpen] = useState(false)
  const archived = Boolean(customer.archivedAt)
  const linkedCount = customer.requiredDocs.filter((doc) => doc.linkedVaultDocId).length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex cursor-pointer items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
        >
          <ArrowLeft size={14} /> Back to customers
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-[var(--text)]">{customer.name}</h1>
              <Badge tone={STATUS_TONE[customer.status]}>{STATUS_LABEL[customer.status]}</Badge>
              {archived && <Badge tone="amber">Archived</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              {customer.industry || 'Sector not stated'} · Working together since {customer.since}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" onClick={onEdit}>
              <Pencil size={13} /> Edit customer
            </Button>
            {archived ? (
              <Button variant="primary" onClick={onRestore} title="Make this customer active again">
                <RotateCcw size={13} /> Restore
              </Button>
            ) : (
              <Button
                variant="default"
                onClick={onArchive}
                title="Set this customer aside without deleting anything"
              >
                <Archive size={13} /> Archive
              </Button>
            )}
            <button
              type="button"
              onClick={() => setRemoveOpen((open) => !open)}
              aria-expanded={removeOpen}
              title="See what a permanent delete would affect"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-bg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              <Trash2 size={13} aria-hidden="true" /> Remove…
            </button>
          </div>
        </div>

        {removeOpen && (
          <div className="mt-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3">
            <p className="text-[13px] font-semibold text-[var(--text)]">
              Removing a customer is not available yet
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              Archive the customer instead — the record is kept and can be restored. Nothing here
              erases files: removing a vault document moves it to Trash, where you can restore it. A
              permanent delete would affect:
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-[var(--text-secondary)]">
              <li>
                {customer.requiredDocs.length} document requirement
                {customer.requiredDocs.length === 1 ? '' : 's'}
              </li>
              <li>
                {linkedCount} link{linkedCount === 1 ? '' : 's'} to vault documents
              </li>
              <li>No tenders reference a customer directly.</li>
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                disabled
                title="Permanent deletion is not offered — archive the customer instead; vault files removed elsewhere move to Trash and can be restored"
              >
                <Trash2 size={13} /> Delete permanently
              </Button>
              <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
                Keep customer
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-8 py-8 lg:grid-cols-3">
        {/* left: contact + notes */}
        <div className="space-y-4 lg:col-span-1">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">
              Clarifications contact
            </h2>
            {customer.contactName || customer.contactEmail || customer.contactPhone ? (
              <div className="space-y-2.5 text-sm text-[var(--text-secondary)]">
                {customer.contactName && (
                  <div className="flex items-center gap-2">
                    <User size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                    {customer.contactName}
                  </div>
                )}
                {customer.contactEmail && (
                  <div className="flex items-center gap-2">
                    <Mail size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                    <a
                      href={`mailto:${customer.contactEmail}`}
                      className="text-[var(--accent-dark)] hover:underline"
                    >
                      {customer.contactEmail}
                    </a>
                  </div>
                )}
                {customer.contactPhone && (
                  <div className="flex items-center gap-2">
                    <Phone size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                    {customer.contactPhone}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                No contact person recorded yet. Add one so clarification e-mails have somewhere to
                go.
              </p>
            )}
          </section>

          {customer.notes && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Notes</h2>
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                {customer.notes}
              </p>
            </section>
          )}
        </div>

        {/* right: required docs tracker */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">
              Required documents
              <span className="ml-2 text-[11px] font-normal text-[var(--text-tertiary)]">
                {customer.requiredDocs.filter((doc) => doc.fulfilled).length}/
                {customer.requiredDocs.length} ready
              </span>
            </h2>
            <Button size="sm" variant="default" onClick={onEdit}>
              <Pencil size={12} /> Edit requirements
            </Button>
          </div>
          {customer.requiredDocs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
              No document requirements defined yet. Add the documents this customer expects in a bid
              pack.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {customer.requiredDocs.map((requirement, index) => {
                const linked = requirement.linkedVaultDocId
                  ? vault.find((doc) => doc.id === requirement.linkedVaultDocId)
                  : null
                return (
                  <li key={index} className="flex items-start gap-3 py-3">
                    {requirement.fulfilled ? (
                      <CheckCircle2
                        size={16}
                        className="mt-0.5 shrink-0 text-[var(--success)]"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle
                        size={16}
                        className="mt-0.5 shrink-0 text-[var(--danger)]"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-[var(--text)]">
                        {requirement.label}
                      </p>
                      {linked ? (
                        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                          Linked:{' '}
                          <span className="font-medium text-[var(--accent-dark)]">
                            {linked.title}
                          </span>
                          {linked.expiryDate && <> · expires {linked.expiryDate}</>}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                          No vault document linked
                        </p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 text-[11px] font-medium ${DOC_CAT_COLOR[requirement.docCategory]}`}
                    >
                      {requirement.docCategory.charAt(0) +
                        requirement.docCategory.slice(1).toLowerCase()}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      {editDialog}
    </div>
  )
}
